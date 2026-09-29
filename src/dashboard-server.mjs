/**
 * Loopback-only, token-authenticated HTTP server for the Cache Keepalive dashboard.
 *
 * Scope (DESIGN §6 dashboard-server, §7.4):
 *  - bind strictly to 127.0.0.1 on an ephemeral port (0),
 *  - serve only the fixed asset allowlist `index.html`, `app.mjs`, `style.css`,
 *  - expose exactly two API routes: `GET /api/state` and `POST /api/action`,
 *  - never accept the bearer token through a query string or cookie,
 *  - reject cross-origin and DNS-rebinding requests,
 *  - delegate snapshot generation and action handling to injected functions.
 *
 * This module performs no policy work, no RPC, and no logging. It never writes
 * the token anywhere except the resolved return value.
 *
 * @module dashboard-server
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import crypto from 'node:crypto';

/** @typedef {Record<string, unknown>} JsonObject */

/**
 * Minimal shape this module relies on for a response payload. The real
 * `DashboardSnapshot` is owned by `src/contracts.mjs`; this server treats it as
 * an opaque JSON-serializable value.
 * @typedef {object} DashboardSnapshotLike
 */

/**
 * Action accepted by `POST /api/action`. Must be a plain object whose `type`
 * property is a string. The exact union is validated by the coordinator.
 * @typedef {{ type: string } & JsonObject} ActionLike
 */

/**
 * @typedef {object} StartDashboardOptions
 * @property {() => (DashboardSnapshotLike | Promise<DashboardSnapshotLike>)} getSnapshot
 *   Called for authenticated `GET /api/state`.
 * @property {(action: ActionLike) => (DashboardSnapshotLike | Promise<DashboardSnapshotLike>)} dispatch
 *   Called for authenticated `POST /api/action`; receives the parsed action.
 * @property {string} assetsDir Directory holding `index.html`, `app.mjs`, `style.css`.
 * @property {(size: number) => Uint8Array} [randomBytes] Injectable CSPRNG (tests).
 * @property {string} [host] Only `127.0.0.1` is accepted; anything else throws.
 * @property {number} [maxRequestsPerSecond] Server-wide request budget, default 30.
 */

/**
 * @typedef {object} DashboardServer
 * @property {string} url Open URL containing the token in the fragment.
 * @property {number} port Bound loopback port.
 * @property {string} token 256-bit bearer token (base64url).
 * @property {() => Promise<void>} close Idempotent shutdown; destroys all sockets.
 * @property {import('node:http').Server} server Underlying server, exposed for
 *   binding assertions in tests. Not part of the coordinator contract.
 */

/** @type {string} */
const LOOPBACK_HOST = '127.0.0.1';
/** 16 KiB request body ceiling. */
const BODY_LIMIT = 16 * 1024;
/** Fixed Content-Security-Policy for every response. */
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
/** dispatch error `code` values must match this to be reflected back. */
const ERROR_CODE_RE = /^[a-z_]{1,40}$/;
/** dispatch error `status` values that are passed through unchanged. */
const PASS_THROUGH_STATUS = new Set([400, 404, 409, 503]);

/**
 * Fixed asset allowlist. Keys are exact pathnames; values map to a literal file
 * name inside `assetsDir` and the response content type. Nothing else is served.
 * @type {Map<string, {name: string, type: string}>}
 */
const ASSETS = new Map([
  ['/', { name: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.mjs', { name: 'app.mjs', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { name: 'style.css', type: 'text/css; charset=utf-8' }],
]);

/**
 * Parse an HTTP request target into a canonical pathname.
 *
 * Rejects anything that could smuggle a different path past the allowlist:
 * query strings, fragments, percent-encoding, backslashes, NUL bytes, `.`/`..`
 * segments, duplicate slashes, and non-allowlisted characters. A rejected
 * target is surfaced as `null` and the caller responds 404.
 *
 * @param {string | undefined} rawUrl
 * @returns {string | null}
 */
function parseTarget(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 4096) {
    return null;
  }
  if (
    rawUrl.includes('?') ||
    rawUrl.includes('#') ||
    rawUrl.includes('\\') ||
    rawUrl.includes('%') ||
    rawUrl.includes('\0')
  ) {
    return null;
  }
  if (rawUrl !== '/' && !/^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(rawUrl)) {
    return null;
  }
  for (const segment of rawUrl.split('/')) {
    if (segment === '.' || segment === '..') return null;
  }
  return rawUrl;
}

/**
 * True when `action` is a non-null, non-array plain object.
 * @param {unknown} action
 * @returns {action is JsonObject}
 */
function isPlainObject(action) {
  if (action === null || typeof action !== 'object' || Array.isArray(action)) {
    return false;
  }
  const proto = Object.getPrototypeOf(action);
  return proto === Object.prototype || proto === null;
}

/**
 * Accept `application/json` with optional parameters (e.g. `;charset=utf-8`).
 * @param {unknown} value
 * @returns {boolean}
 */
function isJsonContentType(value) {
  if (typeof value !== 'string') return false;
  const semicolon = value.indexOf(';');
  const media = (semicolon === -1 ? value : value.slice(0, semicolon)).trim().toLowerCase();
  return media === 'application/json';
}

/**
 * Read a request body up to `limit` bytes. Rejects with `code:
 * 'payload_too_large'` as soon as the limit is exceeded; the caller must stop
 * the stream and respond 413.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
    };

    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        cleanup();
        req.pause();
        reject(Object.assign(new Error('payload too large'), { code: 'payload_too_large' }));
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks));
    };

    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onAborted = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

/**
 * Start the dashboard HTTP server.
 *
 * @param {StartDashboardOptions} options
 * @returns {Promise<DashboardServer>}
 */
export async function startDashboard({
  getSnapshot,
  dispatch,
  assetsDir,
  randomBytes = crypto.randomBytes,
  host = LOOPBACK_HOST,
  maxRequestsPerSecond = 30,
} = {}) {
  if (host !== LOOPBACK_HOST) {
    throw new Error(`dashboard server refuses non-loopback host: ${String(host)}`);
  }
  if (typeof getSnapshot !== 'function' || typeof dispatch !== 'function') {
    throw new TypeError('startDashboard requires getSnapshot and dispatch functions');
  }
  if (typeof assetsDir !== 'string' || assetsDir.length === 0) {
    throw new TypeError('startDashboard requires a non-empty assetsDir');
  }

  const token = Buffer.from(randomBytes(32)).toString('base64url');
  const tokenBuffer = Buffer.from(token, 'utf8');

  // Server-wide fixed-window rate limit. Counted for every request, including
  // rejected ones, so a flood cannot be hidden behind failing requests.
  let windowStart = Date.now();
  let windowCount = 0;
  const allowRequest = () => {
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    return windowCount <= maxRequestsPerSecond;
  };

  const securityHeaders = () => ({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': CSP,
  });

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {object} payload
   * @param {Record<string, string | number>} [extra]
   */
  const respondJson = (res, status, payload, extra = {}) => {
    if (res.headersSent || res.writableEnded) return;
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    res.writeHead(status, {
      ...securityHeaders(),
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      ...extra,
    });
    res.end(body);
  };

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {number} status
   * @param {string} code
   * @param {Record<string, string | number>} [extra]
   */
  const respondError = (res, status, code, extra) => {
    respondJson(res, status, { error: { code } }, extra);
  };

  /**
   * Constant-time bearer check. Query strings and cookies are never consulted.
   * @param {import('node:http').IncomingMessage} req
   * @returns {boolean}
   */
  const authorized = (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      return false;
    }
    const candidate = Buffer.from(header.slice('Bearer '.length), 'utf8');
    if (candidate.length !== tokenBuffer.length) {
      return false;
    }
    return crypto.timingSafeEqual(candidate, tokenBuffer);
  };

  /** @type {number} */
  let port = 0;

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  const onRequest = async (req, res) => {
    try {
      if (!allowRequest()) {
        respondError(res, 429, 'rate_limited');
        return;
      }

      const pathname = parseTarget(req.url);
      if (pathname === null) {
        respondError(res, 404, 'not_found');
        return;
      }

      // DNS-rebinding guard: only the exact loopback authority is trusted.
      if (req.headers.host !== `${LOOPBACK_HOST}:${port}`) {
        respondError(res, 421, 'misdirected');
        return;
      }

      if (req.method === 'OPTIONS') {
        respondError(res, 405, 'method_not_allowed');
        return;
      }

      const asset = ASSETS.get(pathname);
      const isState = pathname === '/api/state';
      const isAction = pathname === '/api/action';
      if (!asset && !isState && !isAction) {
        respondError(res, 404, 'not_found');
        return;
      }

      const expectedOrigin = `http://${LOOPBACK_HOST}:${port}`;
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== expectedOrigin) {
        respondError(res, 403, 'forbidden');
        return;
      }

      if (asset) {
        if (req.method !== 'GET') {
          respondError(res, 405, 'method_not_allowed');
          return;
        }
        let data;
        try {
          data = await readFile(join(assetsDir, asset.name));
        } catch (err) {
          respondError(res, err && err.code === 'ENOENT' ? 404 : 500, err && err.code === 'ENOENT' ? 'not_found' : 'internal');
          return;
        }
        if (res.headersSent || res.writableEnded) return;
        res.writeHead(200, {
          ...securityHeaders(),
          'Content-Type': asset.type,
          'Content-Length': data.length,
        });
        res.end(data);
        return;
      }

      if (isState) {
        if (req.method !== 'GET') {
          respondError(res, 405, 'method_not_allowed');
          return;
        }
        if (!authorized(req)) {
          respondError(res, 401, 'unauthorized');
          return;
        }
        let snapshot;
        try {
          snapshot = await getSnapshot();
        } catch {
          respondError(res, 500, 'internal');
          return;
        }
        respondJson(res, 200, snapshot === undefined ? null : snapshot);
        return;
      }

      // POST /api/action
      if (req.method !== 'POST') {
        respondError(res, 405, 'method_not_allowed');
        return;
      }
      if (origin === undefined) {
        respondError(res, 403, 'forbidden');
        return;
      }
      if (!isJsonContentType(req.headers['content-type'])) {
        respondError(res, 415, 'unsupported_media_type');
        return;
      }
      if (!authorized(req)) {
        respondError(res, 401, 'unauthorized');
        return;
      }

      let raw;
      try {
        raw = await readBody(req, BODY_LIMIT);
      } catch (err) {
        if (err && err.code === 'payload_too_large') {
          respondError(res, 413, 'payload_too_large', { Connection: 'close' });
          return;
        }
        respondError(res, 400, 'bad_request');
        return;
      }

      let action;
      try {
        action = JSON.parse(raw.toString('utf8'));
      } catch {
        respondError(res, 400, 'bad_json');
        return;
      }
      if (!isPlainObject(action) || typeof action.type !== 'string') {
        respondError(res, 400, 'bad_request');
        return;
      }

      let result;
      try {
        result = await dispatch(/** @type {ActionLike} */ (action));
      } catch (err) {
        const status =
          err && PASS_THROUGH_STATUS.has(err.status) ? err.status : 500;
        const code =
          err && typeof err.code === 'string' && ERROR_CODE_RE.test(err.code)
            ? err.code
            : 'internal';
        respondError(res, status, code);
        return;
      }
      respondJson(res, 200, result === undefined ? null : result);
    } catch {
      // Never leak error details; a late failure still gets a safe response.
      respondError(res, 500, 'internal');
    }
  };

  const server = createServer((req, res) => {
    void onRequest(req, res);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('clientError', (_err, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } else {
      socket.destroy();
    }
  });

  await new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(undefined);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(0, LOOPBACK_HOST);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('dashboard server failed to bind to a loopback port');
  }
  port = address.port;

  let closed = false;
  /** @type {() => void} */
  let resolveClosed = () => {};
  const closedPromise = new Promise((resolve) => {
    resolveClosed = () => resolve(undefined);
  });
  server.once('close', () => resolveClosed());

  const close = async () => {
    if (!closed) {
      closed = true;
      server.close(() => {});
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
    }
    await closedPromise;
  };

  return {
    url: `http://${LOOPBACK_HOST}:${port}/#token=${token}`,
    port,
    token,
    close,
    server,
  };
}

export default startDashboard;
