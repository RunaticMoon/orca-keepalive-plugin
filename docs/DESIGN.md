# 📐[OKAP-D1C9] A : keepalive 플러그인 설계·작업분해

메인 세션: `d1c95493-9e61-4d10-b463-ead7c6b89339` · 공통 코드: `OKAP-D1C9` · 설계 작업: A.
작성 기준: 2026-09-29 KST. 제품 코드 변경·에이전트 생성·배포 없이 이 문서만 작성했다.
아래 B 이후 ID는 **지휘자가 확정할 예약안**이다. 이미 사용된 A를 재사용하지 않는다.

## 1. 목표와 결론

Orca의 프롬프트 캐시 타이머가 켜져 있을 때 Claude 터미널에 짧은 메시지를 보내고, 터미널·워크트리별 버튼 및 전체 일시정지로 제어하는 커뮤니티 플러그인을 만든다. 빌드 없는 ESM, 외부 npm 의존성 0, `node:test`, JSDoc을 사용한다.

**권장안은 플러그인 이벤트/커맨드 + 로컬 런타임 RPC + 활성 프로필 SQLite 읽기 + 루프백 대시보드다.** 공개 플러그인 API만으로는 요구사항을 구현할 수 없다. RPC 연결 실패 시 `terminal.sendText`로 우회하지 않고 전송을 중단한다.

다만 현재 Orca만으로 다음의 강한 보장은 불가능하다.

- 렌더러의 캐시 타이머 시작 시각과 정확히 일치하는 예약.
- UI에서 타이머를 끈 순간부터 전송이 즉시 금지되는 원자적 조건 검사.
- 모든 실제 사람 키 입력의 감지와 keepalive/다른 자동화/사람의 완전한 구분.
- 초안 검사 이후 Enter까지 입력이 바뀌지 않았다는 원자적 보장.
- 실제 Anthropic 캐시 적중·TTL·과금 절약 보장. 여기서 TTL은 Orca 사용자가 선택한 추정값이다.

출시 설명은 “관측한 작업 완료를 기준으로 캐시 유지 메시지를 예약”으로 한다. 초안 보호는 최선 노력이라는 한계를 명시한다. 이 한계가 허용되지 않는 제품 기준이라면 §12의 Orca 상위 API 변경이 선행되어야 한다. 이 문서는 현재 버전에 가능한 플러그인 구현안을 구체화하며 상위 제품 수정을 작업 범위에 넣지 않는다.

## 2. 조사 기준과 확인된 근거

소스 루트 `O=/tmp/okap/orca`, 체크아웃 commit `b6c2de9f9277c49370644eed37169dc65b3e6279` (제공된 v1.4.214). 아래 `src/...:N`은 이 commit의 O 기준 경로·시작 라인이다. 최신 Orca 전체 버전에 대한 보증은 아니다. 실제 Orca 실행 파일은 이 머신에 없어 아래는 소스 조사 결과이며 실기 재현 결과가 아니다.

| 참조 | 확인한 사실과 소스 |
|---|---|
| S01 | manifest 파일은 `orca-plugin.json`; pluginApi 1, `contributes` strict. `src/shared/plugins/plugin-manifest.ts:53`, `:63`, `:76`, `:144`. 키바인딩은 `{command,key,when?}`: `src/shared/plugins/plugin-content-pack-contributions.ts:25`. |
| S02 | `activate` default export, 별도 named `deactivate`를 host가 호출한다. activate 반환 함수를 cleanup으로 쓰지 않는다. `src/main/plugins/plugin-host-runtime.ts:67`, `:83`, `:119`, `:194`. 준비 10초, 커맨드 30초, idle reap 5분: `src/shared/plugins/plugin-host-protocol.ts:108`. |
| S03 | worker는 `fork`, `ELECTRON_RUN_AS_NODE`, execArgv 비움. `src/main/plugins/plugin-host-process.ts:79`. env allowlist에 HOME/USERPROFILE은 있고 APPDATA, XDG_CONFIG_HOME, ORCA_USER_DATA_PATH는 **없다**: `src/main/plugins/plugin-worker-env.ts:8`. 메인 사망 시 worker도 종료: `src/main/plugins/plugin-host-entry.ts:38`. |
| S04 | plugin workspace context에는 worktreeId/포커스 pane 없음. 반환 terminal.id는 RPC handle과 같다: `src/main/plugins/plugin-host-method-bindings.ts:72`, `src/main/plugins/plugin-host-service-bindings.ts:53`. plugin sendText만 활성 워크트리 제한, raw send: 같은 bindings `:92`, service bindings `:63`. |
| S05 | 이벤트는 combined state와 optional mainAgent만 투영하며 restoredUnconfirmed를 버린다: `src/main/plugins/plugin-agent-status-event.ts:10`. 이벤트 schema는 state를 문자열로 받으므로 알 수 없는 값도 거절 없이 올 수 있다: `src/shared/plugins/plugin-events.ts:28`. mainAgent.stateStartedAt은 실행 호스트 시계: 같은 파일 `:43`. |
| S06 | paneKey=`tabId:leafId`; leafId는 소문자 UUID, tabId에 콜론 금지: `src/shared/stable-pane-id.ts:22`. pane→handle에는 worktree 확인 기능이 있다: `src/main/runtime/orca-runtime-resolve-terminal-pane.ts:19`. |
| S07 | RPC metadata=`<userData>/orca-runtime.json`, runtimeId/pid/transports/authToken/startedAt: `src/shared/runtime-bootstrap.ts:16`, `:50`. OS별 경로/override는 `src/cli/runtime/metadata.ts:46`. |
| S08 | 한 요청마다 socket 연결, UTF-8 줄단위 JSON, top-level authToken, UUID id: `src/cli/runtime/transport.ts:10`, `:32`, `:105`, `:186`. 성공/실패/keepalive envelope: `src/shared/runtime-rpc-envelope.ts:22`, `:31`, `:46`. |
| S09 | terminal RPC params: `src/shared/rpc-contract/terminal-unary-params.ts:11`, `:32`, `:45`, `:62`, `:102`. 호출과 응답 wrapper: `src/main/runtime/rpc/methods/terminal/terminal-query-methods.ts:13`. |
| S10 | 목록 결과는 terminals/totalCount/truncated/hostScope?이고 agentIdentity·ptyId·incarnationId?·lastOutputAt 등이 있다: `src/shared/runtime-terminal-contracts.ts:15`, `:91`. `agentIdentity`는 `'claude'` 같은 TuiAgent 문자열: `src/shared/tui-agent.ts:3`. 이름/title 검색으로 Claude를 추측하지 않는다. |
| S11 | `terminal.send`에 활성 워크트리 제약은 없다. handle→live leaf/PTY 검증 및 desktop/mobile 입력 잠금이 있다: `src/main/runtime/rpc/methods/terminal/terminal-send-method.ts:73`, `:91`; `src/main/runtime/orca-runtime-controller-knows-pty-is-live.ts:94`. desktop client는 mobile driver이면 차단: `src/main/runtime/rpc/methods/terminal/terminal-input-delivery.ts:11`. |
| S12 | `requireAgentStatus:'sendable'` + nonempty text + enter/interrupt는 즉시 accepted:false, bytesWritten:0. text와 Enter 분리 필요: `terminal-send-method.ts:127`. guard는 no-agent/permission/PTY 교체를 막지만 **working까지 막지는 않는다**: `src/main/runtime/rpc/terminal-agent-send-guard.ts:13`. |
| S13 | agentPrompt의 settled 경로 조건은 agentPrompt=true, text 있음, enter=true, interrupt 아님, client.type=desktop, foreground agent가 지원됨: `terminal-send-method.ts:191`. 조건 실패 시 raw send로 내려간다: 같은 파일 `:209`. 지원 foreground는 claude/codex: `src/main/runtime/orca-runtime-get-pty-record-for-pane-key.ts:113`. |
| S14 | settled prompt는 bracketed paste, PTY generation 확인, paste 전/Enter 전 permission 재검사, 제출 효과 검증을 한다: `src/main/runtime/orca-runtime-write-terminal-agent-prompt.ts:25`. 일반 요청에서는 prompt receipt가 없을 수 있고, waitSubmitMs는 orchestrationMutation 분기에서만 사용: `terminal-send-method.ts:218`, write 파일 `:110`. 입력 초안의 원자적 비교 조건은 없다. |
| S15 | `terminal.show`는 agentWait=null(검사상 없음), object(대기), absent(미평가)를 구분: `src/shared/runtime-terminal-contracts.ts:160`; 실제 생성 `orca-runtime-resolve-terminal-pane.ts:131`. `terminal.read {screen:true}`는 screen/stream/screen-unavailable 구분, draft? 반환: 같은 파일 `:179`. |
| S16 | draft는 UI 입력 이벤트가 아니라 emulator의 cursor·화면에서 감지한 문자열: `src/main/runtime/orca-runtime-terminal-projection.ts:27`, `src/shared/terminal-composer-draft.ts:1`. draft가 없다는 것만으로 입력창이 비었다고 증명되지 않는다. 공개 terminal query에 lastHumanInputAt/inputRevision 계약은 없다. |
| S17 | runtime `settings.get` 자체는 있지만 공개 projection에서 캐시 타이머 키를 제외한다: `src/main/runtime/rpc/methods/client-ui.ts:17`, `src/main/runtime/runtime-client-settings.ts:27`, `:100`. plugin의 동명 host.call 설정 API와도 다르다. |
| S18 | 활성 프로필은 `<userData>/orca-profile-index.json`의 activeProfileId와 profiles[].id: `src/main/persistence/profile-state/profile-state-active-location.ts:10`. 프로필 경로는 `profiles/<id>/orca-data.json` 및 `profiles/<id>/profile-state.db`: `src/shared/profile-state-storage-paths.ts:3`. 원래 루트 orca-data.json을 무조건 읽으면 틀린 프로필/오래된 값을 읽는다. |
| S19 | SQLite schema version 3, `profile_state_meta(key,value)`, `profile_state_documents(domain,payload,domain_version,revision,updated_at,content_hash)`: `src/main/persistence/profile-state/profile-state-database-schema.ts:8`. settings domain payload는 settings 객체 자체. 읽기 전용·현재 DB 우선 원칙: `profile-state-database.ts:142`. hash는 payload 원문 SHA-256 hex: `profile-state-document-validation.ts:41`. |
| S20 | Orca 자체가 node:sqlite DatabaseSync를 사용하며 미지원 runtime을 구분: `src/main/sqlite/sync-database.ts:37`, `:79`. 대상 package의 Electron 선언은 43.7.5: `package.json:259`. 실제 plugin worker에서도 built-in 이용 가능 여부를 feature probe해야 한다. |
| S21 | settings 업데이트는 scheduleSave를 호출: `src/main/persistence/applying-settings/settings-update.ts:273`. 디스크 쓰기는 debounce 1초, 최대 대기 5초 및 비동기 queue: `src/main/persistence/loading-store/write-scheduling.ts:5`, `:41`. 파일 읽기는 UI 메모리값과 즉시 일치하지 않는다. |
| S22 | 기본 timer=false, TTL=300000: `src/shared/default-global-settings.ts:176`. 렌더러의 관측 working→idle에서 Date.now() 기록, stale title clear는 null: `src/renderer/src/components/terminal-pane/pty-connection/agent-task-complete-notify.ts:139`, `:173`. working 전환에서 null: 인접 `agent-idle-working-handlers.ts:28`. |
| S23 | 브라우저 RPC는 `browser.tabCreate`/`browser.openUrl`: `src/main/runtime/rpc/methods/browser-core.ts:110`. params는 `src/shared/rpc-contract/browser-tab-create-params.ts:6`, `:20`. openUrl은 http(s)만 받고 browser host lease를 선택: `src/main/runtime/runtime-browser-commands-browser-tab-create.ts:189`. 결과 `{browserPageId}`. |
| S24 | resolveActive는 모든 tab을 순회하며 각 tab의 activeLeafId를 먼저 고르므로 “현재 포커스된 pane” 보장이 없다. requireUnambiguous=true는 activeLeaf 경로를 건너뛰며 후보가 여러 개면 실패: `src/main/runtime/orca-runtime-adopt-terminal-orphans-from-inventory.ts:94`. |
| S25 | marketplace identity는 publisher.id, source={kind:git,url,ref}; ref 필수, reserved publisher stablyai/id prefix orca-: `src/shared/plugins/plugin-marketplace.ts:9`, `:43`, `:56`, `:137`. 로컬 인덱스 `/tmp/okap/orca-plugins/orca-marketplace.json`을 대조했다. |

참고 도구 [claude-cache-keepalive README](https://github.com/fifthadj/claude-cache-keepalive)는 PTY 소유, transcript 기반 시각/TTL, quiet window, disable 파일을 사용한다. 여기서는 Orca의 PTY를 재소유하지 않는다. 동작 개념만 참고하고 코드를 복사하지 않는다. 메시지는 사용량을 소비하고 대화에 남으므로 대시보드에 해당 사실을 짧게 표시한다.

## 3. 지휘자 잠정 결정별 확정·수정

| 안 | 결정 | 이유·구현 영향 |
|---|---|---|
| 1 하이브리드 | 확정, RPC 불가 시 전송 중단 | S01–S16. plugin raw sendText fallback은 안전 guard를 잃으므로 제외. 직접 RPC는 plugin capability로 격리되지 않는 내부 계약 의존임을 README에 공개. |
| 2 앱 설정 파일 | 수정하여 확정: 활성 프로필 SQLite 우선, DB 없는 legacy 프로필만 JSON | S17–S21. runtime settings.get으로 대체할 수 없다. fs.watch만으로는 WAL 변화를 놓칠 수 있어 읽기 polling. 읽기 오류·미지원 schema는 disabled/unknown 취급. 앱 설정은 절대 쓰지 않는다. |
| 3 시각·안전·상한 | 수정: 관측 working→done epoch, 4분/58분 목표, 관측당 최대 1회 | renderer timer 복제는 불가능. mainAgent와 combined 상태를 함께 확인. 자체 attempt로 설명되지 않는 fresh working(=실제 작업 turn)이 관측되면 해당 대상 budget을 자동 reset한다(지휘자 결정, §5.3). 기본 3회, 0=무제한, UI의 “횟수 초기화”로도 reset. |
| 4 메시지 | 확정 | 기본 `Cache keepalive. Reply only OK; do not use tools or continue previous work.`. 단일 행, UTF-8 1–512 bytes, 제어문자 금지, trim 후 비어있으면 오류. LLM이 문구를 반드시 따를 보장은 없다. |
| 5 UI | 수정: 대시보드 + 커맨드, panel 제외, “포커스 터미널 토글” 제외 | 패널은 worker 통신 채널이 없다(지휘자 확인 사항). 현재 워크트리는 plugin context terminal handles를 RPC 목록과 join해 고유 ID를 얻는다. 터미널 선택은 대시보드에서 명시적으로 한다. resolveActive로 포커스를 추측하지 않는다(S04,S24). **추가(OKPN-EB52)**: Orca 1.4.214 패널은 postMessage 브리지로 `workspace.readContext`·`terminal.sendText`·`notifications.show`만 호출할 수 있고 storage·명령 실행·worker 통신·네트워크(connect-src none)·navigation이 막혀 있어, 정적 안내 패널(`panel/index.html`)만 추가했다. 상태 확인·on/off는 팔레트 명령과 터미널 CLI(`bin/keepalive.mjs`, 제어 파일 `~/.orca-cache-keepalive/control.json`)로 제공하며, 이를 위해 대시보드 서버는 activate 시 즉시 시작한다. |
| 6 JS/테스트 | 확정 | Node built-ins net/http/crypto/fs/sqlite만 사용. node:sqlite feature probe 실패 시 SQLite 프로필에서는 전송 불가. 순수 machine과 부작용 조정기를 분리. |

### 3.1 전송 대안 비교와 선택

| 경로 | 장점 | 결정 |
|---|---|---|
| plugin terminal.sendText | 단순 | 활성 워크트리 제한·guard 부재로 제외. |
| RPC agentPrompt 단일 요청 | host paste/permission/제출검증 재사용 | guard와 본문+Enter를 함께 쓸 수 없고, unsupported foreground일 때 raw로 조용히 전환한다. 현재 자동 keepalive 기본 경로로 제외. |
| RPC guarded text 후 guarded Enter | no-agent/permission/desktop lock/PTY 결합을 각 단계에서 재검사 가능 | **v0.1 권장**. host guard는 working을 허용하므로 별도 idle 검사 필요. 두 단계 사이 초안을 확인하고 실패 시 멈춘다. |
| Orca에 atomic keepalive RPC 추가 | 타이머·입력 revision·idle 검사를 호스트에서 원자적으로 수행 가능 | 가장 강한 장기안. 이 저장소 구현 범위 밖. |

2단계 전송도 완전한 입력 경쟁 방지가 아니다. UI 읽기→Enter 사이 사용자 타이핑이나 질문 등장 가능성이 남는다. 이 제약을 숨긴 채 “안전 전송 보장”으로 표현하지 않는다. Esc/Ctrl-U/Ctrl-C/초안 자동 복원은 사용자 입력이나 권한 화면을 바꾸므로 사용하지 않는다.

### 3.2 OKPN-EB52 추가 기능(A·B·D) 설계 요약

§3 표의 OKPN-EB52 메모(정적 패널)에 이어 같은 메인 세션에서 추가한 세 기능의 설계
결정이다. 상세 계약은 각 모듈 JSDoc과 사용자 문서(README, TESTING.md)를 따른다.

| ID | 기능 | 설계 |
|---|---|---|
| A | 상태 요약 개선 | `src/dashboard-model.mjs`의 `statusSummary({currentWorktreeId})`가 첫 줄 전역 상태(`켜짐`/`꺼짐(일시정지)` · 타이머 · 연결 · `워크트리 N개`)과 워크트리별 한 줄을 만든다. 현재 워크트리 `▶`, 설정 `켜짐`/`꺼짐` + `(기본값)`/`(직접 설정)`, 캐시 상태 기호와 `유지 중 N · 만료 M · 확인 필요 K`, 일시정지 중 `켜짐(일시정지 중)`, `다음 전송 … 후`. 기호·개수는 설정값(`effectiveEnabled`)이 아니라 `indicatorOn=true` 터미널의 실제 `cacheState`/`cacheStatus`로만 정한다(on 터미널이 없으면 캐시 문구 생략). 480자(`STATUS_MAX_CHARS`)를 넘으면 `… 외 N개`로 자른다. `keepalive-status` 커맨드가 `controller.currentWorktreeId()`(2초 상한, 실패 시 null)를 넘겨 호출해 요약을 알린 뒤 대시보드도 연다(플러그인 알림이 macOS에서 표시되지 않을 수 있음). 원시 worktreeId·경로·토큰은 넣지 않는다. |
| B | 변경 알림 | `src/change-notice.mjs`의 순수 함수 `describeActionChange(action, snapshot)`가 성공한 dispatch의 Action과 새 snapshot으로 200자 이하 한 줄을 만든다. main.mjs가 대시보드 `POST /api/action` dispatch wrapper(터미널 CLI도 같은 경로)에서 응답 뒤 fire-and-forget으로 Orca 알림을 보낸다. 팔레트 명령은 자체 알림을 쓰므로 이 경로를 타지 않는다. worktree는 label(없으면 `워크트리`), terminal은 label/title만 쓰고, 전역 일시정지 중 켜기에는 ` (전체 일시정지 중)` 꼬리말을 붙이며, `config`/`reset-budget`/`clear-review`는 알리지 않는다. |
| D | 캐시 상태 prefix 탭 표시 | 설정 `tabTitleIndicator`(기본 true, `src/config.mjs`; 대시보드 설정 폼 `name="tabTitleIndicator"`, 표시명 **탭 이름에 캐시 상태 표시**). `src/title-indicator.mjs`가 Orca RPC `terminal.rename`으로 Claude 탭의 `customTitle` 앞에 상태 prefix(`⚡ ` 캐시 유지 중 / `💤 ` 유지 중인 캐시 없음 / `⚠️ ` 확인 필요)를 붙인다. desired pane의 `cacheState`(`kept`/`none`/`review`)를 매핑하고, 같은 탭의 on pane만 모아 `review > kept > none`(⚠️ > ⚡ > 💤) 우선순위로 탭 prefix 하나를 고른다. on 조건은 전체 일시정지 아님·앱 타이머 켜짐·런타임 연결·워크트리/터미널 정책 허용(연속 전송 상한 도달 시 일시 false 가능)·(respectCwarmDisabled일 때) `cwarm.disabled` 없음이다. 기록을 storage(`title-indicator-v1`)에 먼저 저장한 뒤 rename하고(선저장 실패 시 기존 복구 기록을 되돌림), prefix 교체는 기존 prefix 제거 + 새 prefix를 한 번의 rename으로 수행한다(2단계 금지). 조건이 깨지거나 종료 시 `title:null`로 해제하며 다음 시작의 reconcile이 잔여 prefix를 정리한다(옵션이 꺼져 있으면 제거, 켜져 있으면 조건에 맞는 탭에 새 handle로 재적용 — storage에서 읽은 기록은 이번 실행에서 미확정으로 취급해 첫 전체 reconcile이 다시 적용한다). **같은 prefix가 confirmed면 pane 순서·handle·phase 변화로 rename하지 않고 handle만 갱신한다.** 실제 턴 완료만을 이유로 하는 refresh rename은 제거했고(`onTurnCompleted`는 호환용 no-op), 그 결과 에이전트가 만든 자동 제목이 늦게 반영될 수 있다. rename 실패는 다음 tick에 재시도하고 탭별 연속 실패 3회에서 그 탭을 이번 실행 동안 건너뛴다. 실패는 삼키고 안전 code만 진단에 남긴다. Orca `session.tabs.list` title은 customTitle이 아니라 런타임 제목 투영값(OSC/PTY)이라 사용자 지정 제목과 비교할 수 없다. 따라서 prefix가 켜진 탭은 off·prefix 변경·플러그인 종료 시 사용자 지정 제목이 해제될 수 있고, 저장 기록도 없고 조회된 제목에도 알려진 prefix가 없는 잔여물은 식별할 수 없어 자동 정리하지 않는다(한계). 한계: prefix 동안 Orca 자동 제목 갱신 정지, 비정상 종료 시 잔존, 같은 탭 분할 창 이름 공유. |

## 4. 런타임 및 저장소 계약

### 4.1 같은 Orca 인스턴스 찾기

1. plugin storage의 `config.runtimeUserDataPath`가 있으면 최우선. 경로는 절대 경로이며 디렉터리 이름 추측으로 보정하지 않는다.
2. 없으면 CLI와 같은 기본 경로를 후보로 사용: Linux `XDG_CONFIG_HOME || ~/.config` 아래 `orca`; macOS `~/Library/Application Support/orca`; Windows `APPDATA/orca`, APPDATA 미상일 때 `~/AppData/Roaming/orca`를 **후보로만** 사용.
3. worker env에서 custom env는 보통 제거된다(S03). 따라서 custom XDG, portable, Orca-dev, Windows roaming 경로는 대시보드에서 override가 필요할 수 있다. 미지원 경로를 찾기 위해 사용자 홈 전체를 탐색하지 않는다.
4. metadata의 pid가 plugin worker `process.ppid`와 같아야 한다. desktop main이 직접 fork한다(S03). 다르면 다른 Orca일 수 있으므로 연결하지 않고 설정 오류를 표시한다. 이 정책 때문에 relay/headless plugin 실행은 v0.1 지원 범위 밖이다.
5. runtimeId/startedAt/pid/endpoint를 binding으로 저장. 각 전송 전 metadata 재읽기. 변경 시 pending abort, 기존 epoch 폐기. metadata token은 메모리에만 보유하고 상태 API·로그에 내보내지 않는다.

RPC 없이도 대시보드 서버와 커맨드 등록은 성공해야 한다. 커맨드가 로컬 URL을 알림으로 제공하고 사용자는 시스템 브라우저에서 경로 override를 설정할 수 있다. 알림은 일반 텍스트이며 클릭 가능한 링크라는 보장은 하지 않는다.

### 4.2 wire 형식

`node:net.createConnection(endpoint)`로 unix socket 또는 named pipe. TCP/웹소켓 fallback 없음. 호출 1개당 연결 1개. 다음 JSON 뒤에 실제 LF 1개를 붙인다(JSON-RPC 2.0 아님).

```json
{"id":"uuid","authToken":"from-metadata","method":"terminal.list","params":{"limit":1000,"includeVisualLayouts":false,"requireFreshPtyLiveness":true}}
```

성공: `{"id":"uuid","ok":true,"result":{},"_meta":{"runtimeId":"expected"}}`.
실패: `{"id":"uuid","ok":false,"error":{"code":"...","message":"...","data":{}},"_meta":{"runtimeId":"expected"}}` (_meta는 실패에서 생략/null runtimeId 가능).
중간 프레임: `{"_keepalive":true}`. 무시하며 idle timeout만 갱신하고 전체 deadline은 갱신하지 않는다. 이 프레임은 Claude에 보내는 keepalive와 무관하다.

부분 UTF-8/분할 LF/한 chunk 여러 프레임, 빈 줄 처리. UTF-8 decoder 사용. 최종 frame id 및 성공 runtimeId 반드시 일치. frame당 4 MiB 상한, 잘못된 JSON·조기 EOF·과대 응답은 연결 종료 후 typed error. 추가 응답 필드는 허용하고 필요한 필드만 검증한다.
read RPC timeout 5초, 전체 deadline 10초; send RPC 5초 전체 deadline. AbortSignal 시 socket destroy. socket 종료가 이미 서버에 전달된 mutation을 취소한다는 보장은 없다. mutation 자동 재시도는 금지한다. 재연결 backoff는 read/bootstrap에만 1/2/5/15/30초 상한.

### 4.3 사용하는 RPC 목록

| method | params | result와 정책 |
|---|---|---|
| terminal.list | `{limit:1000,includeVisualLayouts:false,requireFreshPtyLiveness:true,worktree?:'id:'+id,handles?:string[]}` | `{terminals,totalCount,truncated,hostScope?}`. handles 최대 64개. truncated=true면 목록 전체 정상이라고 취급하지 말고 자동 전송 중단·진단. |
| terminal.resolvePane | `{paneKey,worktreeId}` | `{terminal:{handle,tabId,leafId,ptyId,connected?,worktreeId?,incarnationId?,executionHostId?}}`. 조회 기능만 사용, recoverPane 호출 금지. |
| terminal.show | `{terminal:handle,expectedIncarnationId?}` | `{terminal:Summary & {agentWait?:null|object}}`. agentWait가 absent면 판정 불가로 전송 금지. |
| terminal.agentStatus | `{terminal:handle,expectedIncarnationId?}` | `{agentStatus:{handle,isRunningAgent,status:'working'|'permission'|'idle'|null}}`. `idle`과 isRunningAgent=true만 허용. |
| terminal.read | `{terminal:handle,screen:true,limit:200,expectedIncarnationId?}` | `{terminal:{handle,status,tail,truncated,source,draft?}}`. source='screen', status='running' 필수. 화면 내용은 메모리에서만 검사. |
| terminal.send (paste) | `{terminal:handle,text:'\u001b[200~'+message+'\u001b[201~',requireAgentStatus:'sendable',client:{id:clientId,type:'desktop'},expectedIncarnationId?}` | `{send:{handle,accepted,bytesWritten,refusedReason?}}`. enter/interrupt/agentPrompt/viewport 미포함. raw text 경로에 bracketed paste framing을 명시적으로 제공. |
| terminal.send (submit) | `{terminal:handle,enter:true,requireAgentStatus:'sendable',client:{id:clientId,type:'desktop'},expectedIncarnationId?}` | text/interrupt/agentPrompt 미포함. accepted:true만으로 캐시가 갱신됐다고 표시하지 않는다. 이후 working 관측으로 시작 확인. |
| browser.tabCreate | `{url,worktree?:'id:'+id,activate:true,navigation:'host',waitForRegistration:false,placement:{kind:'server'}}` | `{browserPageId}`. local worktree가 확인될 때만 worktree를 전달하며 그 외에는 생략. 실패하면 URL 알림. 자동 재시도하여 탭 중복 생성하지 않는다. |
| browser.openUrl (참고만) | `{url:'http(s)://...',worktree:'id:'+id}` | `{browserPageId}`. lease 선택으로 원격 client가 열 수 있어 loopback 대시보드 기본 경로로 사용하지 않는다. |

placement의 정확한 허용값은 `server` 또는 `client`다(`src/shared/browser-client-host-placement.ts:17`). `server`는 현재 desktop 런타임의 브라우저를 사용한다. navigation의 `host`는 별개 필드다(`src/shared/runtime-navigation.ts:1`). 포커스된 터미널 선택에는 terminal.resolveActive를 사용하지 않는다.

### 4.4 앱 타이머 설정 읽기

`orca-profile-index.json`을 읽고 activeProfileId가 profiles 배열에 존재하는지, `/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/`인지 검증한다. index가 없거나 손상되면 unknown으로 중지한다. 자동화에서는 오래된 `.bak`의 다른 프로필을 fallback하지 않는다.

DB가 있으면 `node:sqlite`를 dynamic import하여 `new DatabaseSync(path,{readOnly:true})`로 연다. 기존 파일 존재를 먼저 확인하고 DB를 생성·migration·checkpoint·VACUUM·journal_mode 변경하지 않는다. `PRAGMA user_version`이 3, meta `profile_id`가 현재 profile과 같아야 한다. 짧은 read transaction 안에서 아래 row를 읽는다.

```sql
SELECT domain, payload, domain_version, revision, updated_at, content_hash
FROM profile_state_documents WHERE domain = 'settings';
```

domain_version=1, revision 양의 안전한 정수, SHA-256(payload UTF-8)=content_hash 확인 후 JSON parse. settings row payload 자체에서 `promptCacheTimerEnabled`/`promptCacheTtlMs`를 선택한다. 최대 payload 4 MiB; 다른 settings 비밀값은 보관·로그·HTTP 반환하지 않는다. DB 오류/busy/hash 오류/미지원 버전/필드 오류는 unknown. DB가 있을 때 JSON으로 fallback하지 않는다. read transaction은 즉시 닫아 WAL writer를 방해하지 않는다.

DB가 **없는** 유효한 프로필만 `profiles/<id>/orca-data.json`의 `.settings`를 읽는다(최대 32 MiB). 읽기 전후 index/profile과 DB 출현 여부를 재검사해 전환 중 결과를 폐기한다. DB-less support에서도 루트 legacy 파일이나 export/backup은 자동 채택하지 않는다.

boolean은 실제 boolean만 수락. timer key 미존재는 disabled. TTL 미존재는 Orca 기본 300000, 그 외 값은 300000/3600000만 허용하며 비정상 값은 unknown. 2초 polling, 전송의 두 단계 직전 강제 재읽기. fs.watch는 선택적 wakeup일 뿐 freshness 근거로 사용하지 않는다. UI off→저장 1–5초+queue→poll 사이 지연은 남는다. 즉시 중지는 플러그인 자체 전역 일시정지로 제공한다. 이미 전송한 bytes까지 회수할 수는 없다.

## 5. 설정·영속 데이터·판정 모델

### 5.1 v0.1 지원 범위

동일 머신의 Orca desktop plugin worker, `agentIdentity === 'claude'`, `executionHostId === 'local'`, 연결된 실제 PTY를 대상으로 한다. execution host 계약은 `src/shared/execution-host.ts:5` 참조. native structured chat, agent-teams 별도 identity, SSH/VM/paired runtime, identity/host 정보가 없는 터미널은 목록에 이유를 표시하되 자동 전송하지 않는다. 비활성 **로컬 워크트리**는 지원한다. 폴더 workspace도 유효한 worktreeId/PTY라면 같은 방식으로 지원한다.

hooks를 통한 fresh working→done 관측을 예약 기준으로 삼는다. 제목만으로 전송 예약을 만들지 않는다. `terminal.agentStatus`의 idle은 최종 안전 조건으로 사용한다. hooks가 없거나 시작 시 이미 idle인 터미널은 “다음 작업 완료 대기”다. 사용자 명시 선택 없이 현재 시각으로 타이머를 임의 시작하지 않는다.

### 5.2 사용자 설정 JSON 및 검증

```json
{
  "schemaVersion": 2,
  "runtimeUserDataPath": null,
  "paused": false,
  "defaultWorktreeEnabled": true,
  "message": "Cache keepalive. Reply only OK; do not use tools or continue previous work.",
  "margin5mMs": 60000,
  "margin1hMs": 120000,
  "quietOutputMs": 2500,
  "observedInputQuietMs": 30000,
  "maxConsecutiveKeepalives5m": 8,
  "maxConsecutiveKeepalives1h": 3,
  "respectCwarmDisabled": true,
  "tabTitleIndicator": true,
  "logLevel": "info"
}
```

- unknown 설정 key 거절. 저장·출력 schemaVersion은 2이고 입력은 1(레거시)과 2를 수락한다. 저장된 v1은 로드 시 v2로 마이그레이션하고 그 결과를 즉시 1회 저장한다(이미 v2인 저장값은 쓰지 않음): `maxConsecutiveKeepalives`가 옛 기본값 3이면 새 기본값(5m=8, 1h=3)을 쓰고, 아니면 그 값을 두 키에 복사한다. config patch에 레거시 키 `maxConsecutiveKeepalives`가 오면 두 키에 같은 값을 적용한다(호환). 로드 마이그레이션 시 `tabTitleIndicator`를 한 번 true로 켠다(옛 기본 false와 사용자가 끈 값을 구분할 수 없음). 단 설정 patch 경로(current가 v1)에서는 강제로 켜지 않고 current 값을 유지한다. v2 설정을 이전 버전 플러그인이 읽으면 `unsupported_schema`로 거부될 수 있다(다운그레이드 주의). 상위 schema 파일은 덮어쓰지 않고 pause.
- margin5mMs=30000..120000, margin1hMs=60000..600000 정수. TTL보다 작아야 한다.
- quietOutputMs=2500..60000; observedInputQuietMs=10000..300000; maxConsecutiveKeepalives5m·maxConsecutiveKeepalives1h=0..1000 정수(0 무제한). 현재 Orca 타이머 TTL(`promptCacheTtlMs`)에 해당하는 키를 적용하고, TTL을 알 수 없으면 두 값 중 작은 제한을 적용한다. 대시보드 설정 폼은 두 값을 따로 편집하고, 터미널 행 `연속 x/상한 y`는 현재 TTL 기준 상한을 보여준다. message 계약은 §3. 사용자 UI에는 상한을 “직접 초기화 전 최대 유지 메시지 횟수”로 정확히 표현한다.
- poll=2000ms, hostHeartbeat=60000ms, preflight 최대 5000ms, minimumRemaining=10000ms, paste 확인 deadline=5000ms, turn-start 확인=15000ms, 송신 concurrency=1은 내부 상수다. 초 단위 빠른 TTL은 테스트 의존성 주입으로만 지원하고 사용자 설정에는 넣지 않는다.
- runtimeUserDataPath 변경은 모든 epoch를 취소하고 새 binding을 확인한 뒤 다음 fresh turn을 기다린다.
- 플러그인 설정은 host `storage.get/set`의 key `state-v1`에 저장. `settings:own`은 필요 없다. 앱 timer 설정은 읽기 전용이며 dashboard에서 변경하는 값은 플러그인 자체 설정뿐이다. epoch 예약·표시 이력 저장은 `state-v1`과 분리된 key `epochs-v1`에 하며(§5.6), revision/409 충돌 검사는 `state-v1`에만 적용된다.

### 5.3 영속 상태 계약

```js
// src/contracts.mjs의 JSDoc으로 선언; 여기의 Map은 JSON에서는 배열로 저장한다.
PersistedState = {
  schemaVersion: 1, revision: number, config: Config,
  profiles: [{
    userDataKey: string, profileId: string,
    worktrees: [{worktreeId: string, enabled: boolean}],
    terminals: [{worktreeId: string, paneKey: string, enabled: boolean}],
    budgets: [{
      worktreeId: string, paneKey: string,
      charged: number, confirmed: number,
      lastAttempt: null | {attemptId, runtimeId, ptyId, epochId, phase, at},
      needsReview: boolean
    }]
  }]
}
```

envelope의 `schemaVersion`(위 PersistedState의 `1`)은 `config`의 schemaVersion(§5.2)과 별개이며 1로 유지된다.

userDataKey는 realpath(userData)의 SHA-256. 사용자 경로 문자열을 HTTP에 그대로 내보내지 않는다. worktreeId/paneKey는 opaque 문자열로 다루고 경로를 파싱하지 않는다. 객체 key 대신 배열/Map으로 prototype pollution을 피한다. 행 제한: profile 32, worktree 1000, terminal/budget 각 2000; 넘으면 저장 오류를 표시하고 전송 금지. 자동 GC는 없는 터미널을 즉시 삭제하지 않는다(복원된 pane의 off 설정 보존). 초기 버전에는 “삭제된 대상 설정 정리” 명시 동작만 추가할 수 있으며 필수는 아니다.

행 개수 제한과 별도로 **직렬화한 state-v1 전체 UTF-8 240 KiB** 상한을 적용한다. host는 value당 256 KiB, 전체 storage 5 MiB 제한이다(`src/shared/plugins/plugin-host-api.ts:68`). prospective mutation을 직렬화하여 상한을 검사하고 넘으면 write/send를 거절한다. 행 제한이 저장 용량을 보장한다고 가정하지 않는다. off 요청이 저장 용량 문제로 실패해도 메모리 pause는 유지하고 “저장 실패, 재시작 전에 설정 정리 필요”를 표시한다.

우선순위: 앱 timer enabled AND config.paused=false AND disable 파일 없음 AND worktree enabled AND terminal override가 false 아님 AND 지원 가능한 대상/상태. 터미널 on은 worktree off나 전역 pause를 덮어쓰지 않는다. worktree override가 없으면 defaultWorktreeEnabled, terminal override가 없으면 inherit. on/off 버튼은 현재 scope 설정과 실제 적용 상태를 따로 표시한다.

storage 쓰기는 단일 직렬 queue, revision 증가, 저장 성공 뒤 UI 성공 응답. 단, 로드 시 config v1→v2 정규화 저장은 revision을 올리지 않는다. OFF/pause는 먼저 메모리에서 전송을 막은 다음 저장하고, 저장 실패 시 메모리 pause 유지 + 오류 표시. ON/reset/config 변경은 저장 성공 전 적용하지 않는다. reset은 budget만 초기화하고 예약은 새 완료 관측을 기다린다. 재개도 과거 만료 epoch를 부활시키지 않는다.

paste 직전 attempt 예약과 charged 증가를 저장하여 crash 후 같은 attempt를 다시 보내지 않는다. 명백히 `accepted:false,bytesWritten:0`이면 마지막 attempt를 refused로 기록하고 budget 차감 복원 가능. 쓰기 이후 오류/응답 유실은 가능 전송으로 계산하며 needsReview=true. receipt만으로 confirmed를 올리지 않고 working 관측 후 올린다. restart 시 미완료 attempt는 “전송 결과 확인 필요”로 차단한다. 시간 예약은 디스크에서 복원하지 않는다(예외: §5.6 `epochs-v1`의 armed 예약·표시 이력).

**지휘자 결정(설계 수정)**: 연속 상한은 “keepalive만으로 이어진 연속 횟수”다. 자체 attempt의 Enter accepted 이후 15초 turn-start 확인 창 안의 첫 fresh working은 자체 turn으로 보고 budget을 유지한다. 그 외의 fresh working(사람 입력이든 다른 자동화든 실제 작업 turn)은 해당 target의 charged/confirmed를 0으로 자동 reset한다(needsReview는 유지, 자동 해제하지 않음). 사람과 다른 자동화를 구분하지 못해도 ‘실제 작업이 있었다’는 의미로 충분하다. 자체 메시지 발생 working/done은 후속 epoch를 만들고 budget을 유지한다. state-store에 `resetBudget(scope)`를 재사용하며 scheduler는 Decision/reducer 결과에 `budgetReset:true` 플래그를 반환해 coordinator가 저장하도록 한다.

### 5.4 순수 상태 머신

target key는 `[binding.runtimeId, profileId, worktreeId, paneKey, ptyId]`의 tuple. incarnationId가 있으면 함께 저장한다. handle만 바뀌어도 예약을 폐기하고 다시 관측한다(서로 다른 PTY로 이전 금지). paneKey는 문자열을 split해 추측하기보다 목록 row의 `${tabId}:${leafId}`와 정확히 join한다.

```text
UNKNOWN -- fresh working --> BUSY
UNKNOWN -- 리로드 복원(저장한 doneAt·basisAt, §5.6 조건) --> ARMED
UNKNOWN -- 저장된 만료/취소 이력 복원(RESTORE_CACHE_HISTORY) --> EXPIRED 또는 SUSPENDED (예약 없음)
BUSY -- fresh combined done + main done/absent --> ARMED
ARMED -- due + 모든 safety 조건 --> CHECKING
CHECKING -- 예약 저장 성공 --> PASTING
PASTING -- paste 확인 + 재검사 통과 --> SUBMITTING
SUBMITTING -- Enter accepted --> AWAITING_TURN
AWAITING_TURN -- working 관측 --> BUSY (자체 attempt 확인)
BUSY -- 다음 done --> ARMED (새 epoch, budget 유지)
any -- blocked/waiting/unknown/설정off/끊김 --> SUSPENDED
any -- 불확실한 mutation/부분 paste --> NEEDS_REVIEW
ARMED -- 만료/clock jump/절전 gap --> EXPIRED
any -- 대상 제거/PTY 변경/runtime 변경 --> UNKNOWN 또는 제거
```

`SUSPENDED`는 원인별 표시 상태다. 일시적 출력/known draft는 epoch를 유지하며 마감 전 다시 검사할 수 있다. blocked/waiting, 설정 off, profile/runtime/PTY 변경, hook 상태 미상은 epoch를 폐기한다. NEEDS_REVIEW는 사용자가 입력창을 확인하고 “다음 작업부터 재개”를 누르기 전까지 유지한다. 이 버튼은 bytes를 지우거나 다시 Enter하지 않는다.

입력 이벤트 처리 규칙:

1. accepted 상태 문자열은 working/blocked/waiting/done만. worktreeId=null, 잘못된 paneKey, 유효하지 않은 receivedAt은 무시+진단. 미래 시각이 5초 이상이면 unknown. receivedAt은 같은 pane에서 단조 증가하는 것만 적용한다.
2. 첫 상태가 done이면 예약하지 않는다. fresh working을 본 후 done을 봐야 한다. 중복 done은 timestamp가 바뀌어도 같은 상태면 deadline을 갱신하지 않는다. mainAgent 값 변화만 있는 done도 새 epoch 아님.
3. combined working이면 mainAgent done이더라도 BUSY다. combined done이어도 mainAgent가 존재하고 state가 done이 아니면 전송 금지. mainAgent.outcome의 특정 문자열을 성공으로 추측하지 않는다.
4. epochId는 내부 단조 정수. doneAt=첫 인정 done의 receivedAt(로컬 대상만 지원). basisAt=캐시 기준 시각=턴의 마지막 working 이벤트 receivedAt(≈마지막 API 요청 시작)이며, 없거나 doneAt과 `basisMaxGapMs`(3분) 넘게 차이 나면 doneAt을 쓴다. stateStartedAt은 dedupe 보조값으로만 쓰고 예약 시각으로 사용하지 않는다.
5. `expiresAt=basisAt+ttlMs`; `dueAt=expiresAt-marginMs`. Anthropic 캐시 TTL은 캐시를 읽거나 쓴 요청의 시작부터 흐르고 응답 생성 시간도 TTL을 소모하므로 완료 시각이 아니라 기준 시각을 쓴다. dueAt 이후에도 `now < expiresAt-10000`인 경우만 시도한다. 마감이 지나면 EXPIRED, catch-up 전송 없음.
6. 설정 TTL/여유 변경 시 아직 시도하지 않은 epoch의 dueAt 재계산. 새 deadline이 이미 지났으면 next turn 대기. 안전 조건 변경은 즉시 재검사. elapsed clock은 monotonic clock, 표시 시각은 Date.now. 두 clock delta 차이 >5초 또는 tick gap>10초이면 epoch 전부 폐기(절전·시계 조정 뒤 폭주 방지).
7. 한 epoch에서 mutation 예약 최대 1회. paste 이후에는 동일 epoch 자동 재시도 없음. preflight의 read failure만 아직 마감 전이면 polling으로 재평가한다.
8. “TTL당 1회”는 **완료 기반 cache epoch당 1회**로 정의한다. keepalive 완료가 새로운 epoch를 열므로 대략 4분/58분마다 가능하다. 이전 전송 뒤 전체 TTL까지 별도 cooldown을 걸면 TTL보다 짧게 유지하려는 목표와 충돌하므로 사용하지 않는다.

### 5.5 전송 직전·단계 사이 안전 규칙

모든 체크는 같은 target generation/epoch로 수행하고 중간 변경 시 폐기한다. per-target mutex 및 전체 send semaphore=1. 대기 target은 순서대로 재검사하며 만료된 것을 나중에 보내지 않는다.

1. metadata binding, active profile와 timer settings 강제 읽기, 플러그인 pause/overrides/budget, `~/.claude/cwarm.disabled` 존재 확인. 파일 접근이 실패해 상태를 판정할 수 없으면 전송 금지. 이 파일은 읽기만 한다.
2. list/resolvePane/show로 같은 worktreeId,paneKey,handle,ptyId 및 optional incarnation을 확인. connected/writable true, agentIdentity='claude', executionHostId='local'. 목록 truncation/누락/빈 ptyId는 금지.
3. 최신 hook combined done, main done/absent, terminal.agentStatus idle+running, terminal.show.agentWait===null을 요구. 어느 신호든 working/permission/waiting이면 금지. unknown은 idle로 바꾸지 않는다.
4. lastOutputAt가 유효한 number이고 현재 시각보다 미래가 아니며 quietOutputMs 이상 무출력. null은 unknown. screen read에서 running/source='screen'/truncated=false, nonempty draft 없음을 확인. unknown screen은 금지. draft 부재의 검출 한계는 남는다(S16).
5. 관측된 nonempty draft 변화는 observedInputQuietMs 동안 차단하며 이후 draft가 없어도 quiet window를 지킨다. 이것을 “모든 사람 입력 감지”로 부르지 않는다. turn-start를 사람 입력으로 계산하지 않는다.
6. journal에 attempt 예약 저장 후 **guarded paste** 1회. 이 시점부터 timeout/error는 결과 불확실로 NEEDS_REVIEW. reject가 명확하고 bytesWritten=0일 때만 untouched로 처리한다.
7. 최소 500ms 후 최대 5초 동안 screen을 250ms 간격으로 읽어 `draft === config.message`를 정확히 확인한다. 공백 normalization으로 다른 초안을 같다고 만들지 않는다. message가 표시되지 않거나 합쳐져 있거나 truncation이면 Enter 금지·NEEDS_REVIEW. 화면이 안 변한 사실로 성공을 추측하지 않는다.
8. phase별 generation과 앱/플러그인 설정, identity, agentStatus idle, agentWait null을 다시 확인. paste가 발생시킨 출력은 최초 quiet 기준에 재적용하면 매번 false가 되므로 이 단계에서는 250ms 출력 안정 및 draft 일치로 판단한다. Enter 직전에 draft를 최종 재조회한다.
9. **guarded Enter** 1회. desktop client id=`cache-keepalive:<randomUUID>`는 worker 수명 내 고정. mobile driver를 가장하거나 viewport 소유권을 탈취하지 않는다. expectedIncarnationId는 있을 때만 전달하며 이것만으로 보호를 보장하지 않는다.
10. Enter accepted 후 15초 이내 fresh working 관측을 기다린다. 관측이 요청 응답보다 먼저 올 수 있으므로 reservation 이후 이벤트를 버리지 않고 순서대로 반영한다. working 미관측/응답 유실/permission이면 needsReview. 15초 내 working→done 전체가 지나가도 두 이벤트를 처리해 새 epoch가 생겨야 한다.

실제 모델의 cache hit는 확인하지 않으며 성공 문구는 "유지 메시지 전송/작업 시작 관측"까지만 표시한다. 다른 자동화(cwarm 등)가 같은 PTY를 동시에 제어하는 구성은 지원하지 않는다.

### 5.6 epoch·캐시 이력 저장(epochs-v1, v2)

리로드(플러그인 on/off, worker 재기동)는 메모리의 epoch 예약과 관측 이력을 잃는다. `src/epoch-memory.mjs`가 host storage의 key `epochs-v1`에 두 종류의 레코드를 저장하고 다시 시작할 때 복원 후보로 제공한다. `state-v1`(설정·budget journal)과 다른 key이며 revision/409 검사와 무관하다.

- **armed**: ARMED이고 아직 전송하지 않은 epoch(`ARMED && attempted=false`)의 예약이다. `doneAt`·`basisAt`(캐시 기준 시각)과 같은 epoch의 `expiresAt`·`lastBlockReason`을 함께 저장한다.
- **history**: 표시 전용이다. 예약 취소 후 만료 전인 상태와 만료 확정(`expiredAt`) 상태를 포함하며, 어떤 경우에도 전송 예약으로 복원하지 않는다.

저장 형식은 `{version:2, entries:{[key]: EpochMemoryRecordV2}}`이다(§5.7). key는 `worktreeId + "\u0000" + paneKey`이고, 나머지 식별자(userDataKey·profileId·ptyId)는 레코드 필드로 비교한다. `incarnationId`는 저장만 하고 복원 조건으로 비교하지 않으며, 바뀐 경우 진단 code로만 알린다. 최대 200개이며 `doneAt`이 오래된 항목부터 제거하고, 직렬화 크기 256 KiB 상한을 넘으면 같은 순서로 레코드를 제거한다.

- **호환:** version 1 레코드는 기존 규칙으로 읽어 `kind='armed'`로 취급하고 basisAt이 없으면 doneAt을 쓴다. v1에는 TTL 정보가 없으므로 `expiresAt`을 null로 두고 과거 만료 시각·원인을 추정해 만들지 않는다. 알 수 없는 version은 복원하지 않으므로 이전 버전으로 다운그레이드하면 v2 저장소를 읽지 못한다(예약을 잘못 되살리는 것보다 복원을 포기하는 편이 안전).
- **prune:** armed는 `now - doneAt >= 1시간`이면 버린다. 단 그 armed가 이미 expected expiry를 지났으면 삭제 전에 `kind='history', expiredAt=expiresAt`으로 전환하고, 그 이력이 24시간 보존을 넘겼으면 바로 제거한다. history는 `now >= expiresAt + CACHE_HISTORY_RETENTION_MS`(24시간)에서 제거한다. `savedAt` 갱신으로 보존 기간을 연장하지 않는다.
- 시작 시 위 prune을 적용한다. load 실패/형식 오류/항목 오류는 빈 상태로 시작하며 throw하지 않는다.
- 저장은 변경 시 직렬 coalesce이고 `storage.set` 실패는 삼킨 뒤 다음 변경 때 재시도한다. 자동 전송 상태(`state-v1`) 저장과 독립이며 복원 실패가 전송을 막지 않는다.
- coordinator는 epoch가 ARMED이고 아직 전송 전일 때만 `remember`하고, 작업중 관측·전송 시도(attempt 예약)·만료·대상 변경 등 ARMED가 아니게 되면 표시 이력이 있으면 `kind='history'`로 낮춰 저장하고 없으면 `forget`한다. 복원 시 catalog에서 같은 `userDataKey`·`profileId`·`worktreeId`·`paneKey`이고 `doneAt`이 1시간 이내인 터미널을 찾는다. `ptyId`는 같아야 한다. **`incarnationId`는 비교하지 않는다** — 달라도(Orca 재시작·업데이트) 복원한다. 복원 시 incarnation이 바뀌었으면 `epoch_restored` 진단에 `code: 'incarnation_changed'`를 붙인다.
  - `kind='armed'`이고 신선도·전송 조건을 만족하며 expected expiry 전이면 `RESTORE_EPOCH`로 ARMED 예약을 되살리고 같은 epoch의 표시 이력도 유지한다.
  - `kind='armed'`인데 expected expiry가 이미 지났으면(오프라인 중 만료) 예약을 버리고 `expiredAt=expiresAt`인 history로 낮춰 표시만 한다(전송 0건).
  - `kind='history'`는 `RESTORE_CACHE_HISTORY`로 표시 상태(EXPIRED 또는 SUSPENDED)만 세우고 절대 `RESTORE_EPOCH`하지 않는다.
  - 해당 scope가 needsReview(열린 attempt·불확실 전송)이면 예약 복원만 차단하고 표시 이력은 보존한다. 검토를 해제해도 표시 이력은 남지만 예약은 되살아나지 않는다.
- 재시작 뒤 셸은 새로 뜨므로 Claude가 다시 실행(예: 세션 재개)되기 전에는 전송 직전 안전 검사에서 대상이 지원되지 않아 전송되지 않고, 예약·예상 만료 시각만 표시된다.
- 재시작 뒤 같은 pane에서 이전 대화가 아니라 새 Claude 세션을 시작하면 복원된 예약에 따라 그 새 세션에 keepalive가 한 번 갈 수 있다(연속 상한 적용). 플러그인 리로드·마켓플레이스 업데이트는 식별자가 유지되어 복원되지만, 플러그인 삭제·재설치는 Orca가 plugins-data를 지우므로 복원되지 않는다.

### 5.7 캐시 상태 표시 계약

새 상태 표시는 전송 예약(scheduler의 epoch)과 **관측 이력**, 그리고 그 둘을 사용자 문구로 바꾸는 **projection**을 분리한다. 실제 Anthropic 캐시 적중 여부가 아니라 관측한 턴과 유효 예약에 근거한 유지 상태다.

**관측 이력(`src/cache-history.mjs`).** 순수 reducer `reduceCacheHistory(history, event)`가 표시 전용 이력을 관리한다. scheduler의 epoch를 대체하지 않고 전송 결정에 관여하지 않는다. 이력은 coordinator의 target entry에만 존재하며 `{epochId(영속 저장 안 함), doneAt, basisAt, expiresAt, lastBlockReason, expiredAt}`를 갖는다. event는 OPEN(인정된 새 epoch의 시각으로 교체·원인 초기화), RETIME(살아 있는 같은 epoch의 expiresAt 갱신, 이미 만료된 이력은 연장 금지), BLOCK(같은 epoch이고 만료 전일 때만 허용 reason 기록, 같은 reason 반복은 no-op), ADVANCE(`now >= expiresAt`이면 `expiredAt=expiresAt` 확정, 만료 24시간 경과 시 null), RESTORE(검증된 저장 레코드에서 복원, epochId=null), CLEAR(새 working/turn 인정 또는 다른 PTY 교체 시 삭제)이다. 허용 reason은 `contracts.EXPIRE_CAUSE_REASONS`뿐이고 `EXPIRED`·`NO_FRESH_TURN`·임의 문자열은 기록하지 않는다. coordinator는 `applyReduce`에서 **변경 전 state를 보존**해 이력을 갱신한다(epoch를 지운 뒤 시각을 찾지 않음). skipped 결과는 시작 때의 `key+target identity+generation+epochId`와 일치할 때만 반영하고, 매 tick `ADVANCE`로 만료 확정과 24시간 정리를 실행 중에도 처리한다.

**저장 레코드 v2(`EpochMemoryRecordV2`).** `{kind:'armed'|'history', userDataKey, profileId, worktreeId, paneKey, ptyId, incarnationId, doneAt, basisAt, expiresAt, lastBlockReason, expiredAt, savedAt}`. 시각은 유한수를 검증하고 `expiredAt !== null`이면 `expiresAt`과 같아야 하며 반드시 `kind='history'`다. `kind='history'`는 `expiresAt`이 필수다. TTL을 알 수 없는 v1에서 올린 armed는 `basisAt`·`lastBlockReason`을 만들지 않고 `expiresAt=null`로 둔다. envelope는 `EPOCH_MEMORY_VERSION=2`이고 key `epochs-v1`을 유지한다.

**`RESTORE_CACHE_HISTORY`(scheduler 내부 입력).** epoch/attempt가 없고 fresh working을 관측하지 않은 초기 UNKNOWN에서만 `expired` 유무에 따라 EXPIRED/EXPIRED 또는 SUSPENDED(+reason)로 표시 phase를 세운다. seenWorking=false, epoch/attempt=null, 예산·자체 턴 카운터를 그대로 두고 예약을 만들지 않는다. 복원 직후 단독 done은 예약하지 않으며 기존 만료 이력을 `NO_FRESH_TURN`으로 덮지 않는다(§5.4 reduceHook). 새 working이 관측되면 BUSY로 전환하고 옛 이력은 삭제된다.

**projection(`src/cache-status.mjs`, 작업 J).** target state·관측 이력·정책·설정에서 `CacheDisplayFields`(`cacheState` `kept|none|review`, `cacheStatus` 9종, `indicatorOn`, `expiresAt`, `expiredAt`, `expireCause`, `blockedReason`, `dueAt`)를 계산해 RuntimeView와 title-indicator의 `desired.cacheState`에 같은 값을 공급한다. `indicatorOn`은 기존 paused/settings/connection/cwarm/scope/상한/storage 실패 조건을 유지하되 **`PARTIAL_OR_UNKNOWN_SEND` 자체는 표시를 끄는 이유에서 제외**한다(그 reason에 가려진 상한·memoryPaused 조건은 별도 확인). 이 예외는 탭 표시에만 적용하고 `safePolicy`나 실제 전송 gate는 바꾸지 않는다. `phase`/`reason`/`effectiveEnabled`는 호환용으로 유지하되 일반 사용자 화면에 phase를 출력하지 않는다.

**탭 기호와 문구(§2-2, §2-7).** `indicatorOn=false` 또는 옵션 off면 기호 없음, `review`면 `⚠️ `, 유지 중(`working`/유효 `scheduled`/`sending`/`awaiting-turn`)이면 `⚡ `, 나머지는 `💤 `다. 같은 탭의 on pane만 `⚠️ > ⚡ > 💤` 순서로 합산하고 같은 기호에서는 rename하지 않는다. 대시보드는 내부 phase 대신 사용자용 문구(`캐시 유지 중 · …`, `캐시 만료됨 · HH:MM · <마지막 차단 사유>`, `예약 없음 · …`, `유지 중단 · …`, `확인 필요 · …`)를 표시하고, "유지 설정 켜짐/꺼짐"과 캐시 상태를 분리한다. 만료 원인은 실제 원인이 아니라 **마지막으로 기록된 전송 차단 사유**이며(예: Orca가 Claude Code의 흐린 프롬프트 제안을 초안으로 오판해 `DRAFT_PRESENT`가 기록될 수 있음), 만료 시각은 관측한 작업과 설정 TTL 기준의 예상이다. scheduler는 실제 만료 10초 전에 전송을 멈추며 그 구간은 `예약 없음 · 안전 전송 시간이 지남 · 만료 예정 HH:MM`으로 표시한다(실제 `expiresAt`이 지나야 "캐시 만료됨").

## 6. 모듈과 인터페이스

모든 파일은 신규 파일이다. `.mjs`만 사용하며 아래 함수명·return shape는 작업 간 계약이다. 외부 I/O는 constructor 인자로 주입하고 import 시 서버/타이머를 시작하지 않는다.

```text
orca-plugin.json  main.mjs  package.json
src/contracts.mjs               JSDoc typedef와 reason code 목록
src/config.mjs                  기본값·입력 검증
src/runtime-location.mjs        경로 후보·metadata·인스턴스 binding
src/rpc-client.mjs              net transport/envelope/timeout
src/orca-settings.mjs           활성 profile와 timer 설정 read-only 읽기
src/state-store.mjs             plugin storage 직렬 journal·정책·budget
src/epoch-memory.mjs            epoch 예약·표시 이력 저장(epochs-v1, envelope v2)
src/cache-history.mjs           표시 전용 캐시 관측 이력 순수 reducer
src/cache-status.mjs            캐시 상태 projection(작업 J)
src/diagnostics.mjs             redaction·bounded ring·JSONL 회전
src/terminal-observer.mjs       RPC typed wrappers·목록·pane join·preflight facts
src/scheduler.mjs               순수 target reducer와 due 결정
src/guarded-send.mjs            paste/read/Enter의 부작용 프로토콜
src/dashboard-server.mjs        loopback HTTP·인증·동작 allowlist
ui/index.html ui/app.mjs ui/style.css
src/commands.mjs                host command 등록·context join·browser 열기
src/coordinator.mjs             이벤트 queue·tick·정책 generation·모듈 조합
test/*.test.mjs                 모듈별 소유 테스트
test/fixtures/fake-runtime.mjs  node:net 가짜 RPC 서버
test/fixtures/fake-host.mjs     orca.commands/events/host.call mock
test/integration/*.test.mjs     전체 상태 흐름 검증
scripts/demo.mjs                선택적 로컬 가짜 환경 시연
README.md docs/TESTING.md docs/PUBLISHING.md LICENSE(소유자 선택 후)
```

| 모듈 | export 시그니처·책임 |
|---|---|
| contracts | typedef Config, Binding, SettingsSnapshot, Target, Observation, TargetState, MachineInput, Decision, SendResult, DashboardSnapshot, DashboardTerminal, CacheDisplayFields, CacheHistory, EpochMemoryRecordV2, RestoreCacheHistoryInput, Action. 상수 `CACHE_STATES`, `CACHE_STATUSES`, `CACHE_HISTORY_RETENTION_MS`(24시간), `TITLE_PREFIXES`, `TITLE_PREFIX_PRIORITY`, `EPOCH_MEMORY_VERSION`(2), `EXPIRE_CAUSE_REASONS`. runtime side effect 없음. |
| config | `DEFAULT_CONFIG`; `parseConfig(value):Config`; `parseConfigPatch(value,current):Config` (throw ValidationError{code,field}). |
| runtime-location | `candidateUserDataPaths({platform,home,env,override}):string[]`; `readRuntimeBinding({userDataPath,parentPid,readFile}):Promise<Binding>`; `sameBinding(a,b):boolean`. Binding={userDataPath,userDataKey,runtimeId,pid,startedAt,endpoint,transportKind,authToken}. |
| rpc-client | `createRpcClient({getBinding,connect,clock,limits}):{call(method,params,{signal,timeoutMs}?):Promise<unknown>,close():void}`. Typed RpcError={code,phase:'connect'|'write'|'response',mayHaveWritten:boolean}. low-level call은 재시도 없음. |
| orca-settings | `readTimerSettings({userDataPath,readFile,openSqlite,now}):Promise<SettingsSnapshot>`. `{known:true,profileId,enabled,ttlMs,revision,source:'sqlite'|'json',readAt}` 또는 `{known:false,reason,readAt}`. reader만 작성; 자체 timer 없음. |
| state-store | `createStateStore({hostCall}):{load(),snapshot(),subscribe(fn),updateConfig(patch),setWorktree(scope,enabled),setTerminal(scope,enabled),reserveAttempt(target,epochId,at),recordAttempt(id,phase),confirmAttempt(id),markReview(id,reason),clearReview(scope),resetBudget(scope),flush()}`. async mutation은 저장 후 snapshot 반환. reserveAttempt는 attemptId 반환. |
| epoch-memory | `EPOCH_MEMORY_KEY='epochs-v1'`; `EPOCH_MEMORY_VERSION=2`; `createEpochMemory({hostCall,now}):{load():Promise<void>,get(key):EpochRecord\|null,remember(key,record):void,forget(key):void,prune(maxAgeMs):void,flush():Promise<void>}`. `state-v1`과 분리된 key에 `kind='armed'`(복원 가능한 예약)와 `kind='history'`(표시 전용) 레코드를 envelope v2로 직렬 coalesce 저장하고 v1 레코드도 읽는다. 최대 200건·직렬화 256 KiB 상한이며 작업 전 1시간·만료 이력 24시간 prune을 적용한다. import 시 I/O·타이머 없음. |
| cache-history | `reduceCacheHistory(history,event):CacheHistory\|null`; `normalizeBlockReason(reason):string\|null`; `isCacheHistoryExpired(history):boolean`. OPEN/RETIME/BLOCK/ADVANCE/RESTORE/CLEAR만 처리하는 부작용 없는 순수 reducer. 시계·타이머·난수·fs·net 없음. |
| diagnostics | `createDiagnostics({log,dir?,fs,now,maxBytes}):{record(event),snapshot(),close()}`. event allowlist만 기록; caller가 raw response를 넣어도 redaction. dir 불가 시 host log+ring 유지. |
| terminal-observer | `createObserver({rpc,hostCall,now}):{list():Promise<Catalog>,resolveEvent(event,catalog):Target|null,inspect(target):Promise<Observation>,currentWorktree(catalog):Promise<string|null>}`. inspect는 show+agentStatus+read를 읽기만 한다. currentWorktree는 context handles join 결과가 정확히 하나일 때만 ID 반환. |
| scheduler | `initialTargetState(target):TargetState`; `reduceTarget(state,input):TargetState`; `decide(state,{now,settings,policy,observation}):Decision`. Decision={kind:'wait'|'inspect'|'send'|'expire',reason,nextAt?}. clock/fs/RPC 없음. |
| guarded-send | `sendKeepalive({target,epochId,message,rpc,inspect,assertAllowed,journal,clock,signal}):Promise<SendResult>`. 결과 `{kind:'submitted'|'refused'|'uncertain',attemptId,reason?,at}`. 캐시/스케줄 결정을 하지 않고 UI/HTTP를 import하지 않는다. |
| dashboard-server | `startDashboard({getSnapshot,dispatch,assetsDir,randomBytes}):Promise<{url,close()}>`. dispatch(Action)은 Promise<DashboardSnapshot>. 반드시 port 0 / 127.0.0.1. |
| commands | `registerCommands({orca,getSnapshot,dispatch,openDashboard,currentWorktree,rpc,notify}):void`. handlers는 무인자; 등록 시점에 I/O하지 않는다. |
| coordinator | `createCoordinator({orca,store,settingsReader,location,rpc,observer,scheduler,sender,diagnostics,clock}):{start():void,onAgentEvent(payload):void,onWorktreeRemoved(payload):void,snapshot():DashboardSnapshot,dispatch(action):Promise<DashboardSnapshot>,stop():Promise<void>}`. start는 즉시 반환; initialize는 내부에서 catch. |
| main | `export default function activate(orca)`; `export async function deactivate()`. 등록을 즉시 완료하고 background bootstrap. 실제 createCoordinator 주입만 수행. |

Observation={target,observedAt,agentStatus,agentWait,connected,writable,identity,executionHostId,lastOutputAt,screenSource,screenTruncated,draft,settingsGeneration}. `draft`와 raw screen은 공개 snapshot에 포함하지 않는다. inspection 사이 값이 충돌하면 unknown.

TargetState={target,phase,lastHook,lastHookAt,lastWorkingAt,seenWorking,epoch:null|{id,doneAt,basisAt,attempted},attempt:null|{id,phase,startedAt},lastObservedInputAt,reason,generation}. `basisAt`은 캐시 TTL 기준 시각(마지막 working receivedAt, 없거나 doneAt과 3분 넘게 차이 나면 doneAt)이다. 순수 reducer의 input 종류는 HOOK, POLICY_INVALIDATED, TARGET_CHANGED, CLOCK_GAP, ATTEMPT_RESERVED, PASTE_ACCEPTED, SUBMIT_ACCEPTED, SEND_REFUSED, SEND_UNCERTAIN, TURN_CONFIRMED, TICK, RESTORE_EPOCH(§5.6 리로드 복원 입력), RESTORE_CACHE_HISTORY(§5.7 표시 이력 전용 복원 입력, 예약을 만들지 않음)이다. 내부 전용 REVIEW_CLEARED·EXPIRE는 `contracts.MACHINE_INPUT_TYPES`에 넣지 않고 scheduler가 직접 처리한다. operation completion은 시작 때의 generation과 다르면 새 상태를 덮어쓰지 않는다.

coordinator는 2초 tick을 setInterval async 중첩으로 구현하지 않는다. 한 tick이 끝난 후 다음 timer를 잡고 hook queue를 drain한다. inspection read concurrency 최대 3, send concurrency 1, 타깃 간 최소 2초 간격. storage heartbeat는 60초마다 `host.call('storage.get',{key:'state-v1'})`; direct socket traffic은 host worker 활동으로 집계되지 않기 때문이다. stop은 timer 해제, generation 증가, abort, 서버/socket close, store flush. shutdown 이후 callback은 새 I/O를 예약하지 않는다.

## 7. UI, command, HTTP 계약

### 7.1 커맨드와 키바인딩

Cmd-J(Windows/Linux Ctrl-J)는 Orca 커맨드 UI에 진입하는 기존 사용 흐름으로 유지한다. 플러그인이 이 키 자체를 가로채지 않는다. 다음 명령을 선언한다.

- `keepalive-open`: 대시보드 열기. 서버가 아직 준비 중이면 최대 5초 기다린 뒤 알림. 정상 local runtime에 browser.tabCreate 1회, 실패하면 URL 표시. URL은 token fragment 포함이며 로그에는 기록하지 않는다.
- `keepalive-toggle-worktree`: 현재 워크트리 on/off. plugin context handles를 완전한 RPC catalog에 join해 worktreeId가 정확히 하나인 경우만 변경. context가 null/빈 터미널/ambiguous면 변경하지 않고 대시보드에서 선택하도록 알림. 동일 branch/displayName으로 매칭 금지.
- `keepalive-pause`: 전역 pause=true (idempotent).
- `keepalive-resume`: 전역 pause=false (budget, 앱 timer off를 무시하지 않음).
- `keepalive-status`: enabled/paused 이유, 관측된 대상/예약/차단 수를 알림. 토큰·원시 화면 없음.

대시보드 단축키 초안 `Mod+Alt+Shift+J`; 충돌이 있으면 설정에서 재지정하거나 단축키를 제거해도 커맨드는 유지한다. 플러그인 자체 터미널 타이핑 hotkey는 구현하지 않는다.

### 7.2 manifest 전체 초안

publisher는 개발 중 `community-keepalive`였고 출시 전 저장소 소유자 계정 `runaticmoon`으로 확정했다(저장소 https://github.com/RunaticMoon/orca-keepalive-plugin, 라이선스 MIT). 설치 후 identity를 바꾸면 별도 플러그인이 되는 점에 유의한다. 저장소 이름은 `orca-keepalive-plugin`이어도 manifest id는 reserved `orca-` 접두를 사용하지 않는다.

```json
{
  "manifestVersion": 1,
  "id": "cache-keepalive",
  "publisher": "runaticmoon",
  "name": "Cache Keepalive",
  "version": "0.1.0",
  "description": "Schedule small keepalive messages for idle Claude terminals, with per-worktree and per-terminal controls.",
  "engines": { "orca": ">=1.4.214" },
  "pluginApi": 1,
  "main": "main.mjs",
  "contributes": {
    "commands": [
      { "id": "keepalive-open", "title": "Cache Keepalive: Open Dashboard", "context": "global" },
      { "id": "keepalive-toggle-worktree", "title": "Cache Keepalive: Toggle Current Worktree", "context": "worktree" },
      { "id": "keepalive-pause", "title": "Cache Keepalive: Pause All", "context": "global" },
      { "id": "keepalive-resume", "title": "Cache Keepalive: Resume", "context": "global" },
      { "id": "keepalive-status", "title": "Cache Keepalive: Show Status", "context": "global" }
    ],
    "events": [
      { "on": "agent.status.changed" },
      { "on": "worktree.removed" }
    ],
    "keybindings": [
      { "command": "keepalive-open", "key": "Mod+Alt+Shift+J", "when": "global" }
    ]
  },
  "capabilities": [
    { "kind": "workspace:read" },
    { "kind": "terminal:send" },
    { "kind": "notifications:show" },
    { "kind": "storage" },
    { "kind": "events:subscribe" }
  ]
}
```

terminal:send를 명시하여 사용 의도를 드러내고 grantedCapabilities에 해당 권한이 없으면 direct RPC sender도 시작하지 않는다. direct fs/net 접근 자체는 host가 이 capability로 중재하지 않으므로 권한 격리 보장으로 설명하지 않는다. manifest engine은 최소 버전 gate일 뿐 향후 내부 RPC 변경을 막지 않는다. 실제 adapter의 known shape 확인이 추가로 필요하다.

### 7.3 대시보드

순수 HTML/CSS/JS, system font, 밝은/어두운 OS 테마, 상태를 색상만으로 구별하지 않음, keyboard focus·label·aria-live error 포함. 패널/외부 폰트/CDN/프레임워크 없음. 서버가 없어지면 “연결 종료, Orca에서 다시 열기”로 표시하고 버튼을 잠근다.

상단: 앱 timer enabled/TTL, plugin pause, runtime 연결/설정 freshness, 전역 pause/resume. 본문은 워크트리별 그룹 및 terminal row: title(plain text), scope 토글, **유지 설정 켜짐/꺼짐**(worktree·terminal 정책과 분리), **캐시 상태 문구**(내부 phase 대신 `캐시 유지 중 · …`, `캐시 만료됨 · HH:MM · <마지막 차단 사유>`, `예약 없음 · …`, `유지 중단 · …`, `확인 필요 · …`), 다음 예정 전송(dueAt이 있을 때만), charged/confirmed, 횟수 초기화. 만료 시각은 관측한 작업·설정 TTL 기준의 예상이며 만료 사유는 실제 원인이 아니라 마지막으로 기록된 전송 차단 사유임을 화면에 명시한다(§2-1, §2-7). 삭제된 대상은 active처럼 보이지 않게 한다. unsupported target도 읽기 전용으로 이유 표시. 단, 에이전트가 없는 일반 터미널(NO_AGENT)은 대시보드 목록에서 숨기고(스냅숏·CLI `status`에는 그대로 남는다), 워크트리의 터미널이 모두 숨겨지면 워크트리 행·토글은 유지한 채 '에이전트가 실행 중인 터미널이 없습니다.'를 표시한다. 수정한 설정은 explicit 저장 버튼을 눌러 반영한다.

“전송 결과 확인 필요”에는 터미널에서 초안을 확인하도록 설명하고 “다음 작업부터 재개” 버튼 제공. 버튼은 pending paste/Enter를 실행하지 않는다. 실시간 테스트 메시지 보내기 버튼은 제공하지 않는다. 사용자에게 앱 timer 설정과 플러그인 자체 설정을 구분해서 보여준다. 최초 화면에 “메시지는 사용량을 소비하고 대화에 남습니다. 입력 감지는 제한적입니다.”를 짧게 표시한다.

### 7.4 루프백 HTTP와 인증

listen(`127.0.0.1`,0), 256-bit crypto random token. 공개 landing `/`에서 assets만 제공하고 데이터/제어는 token 필수. open URL=`http://127.0.0.1:<port>/#token=<base64url>`. app.mjs가 fragment를 읽어 같은 탭 sessionStorage에 저장한 뒤 history.replaceState로 fragment 제거. 새 프로세스에서는 token/port 변경. token을 query/path/cookie에 넣지 않는다.

- 모든 API 요청에 `Authorization: Bearer <token>`. 정확한 길이 검증 후 timingSafeEqual. CORS 허용 헤더 없음. POST는 `Content-Type: application/json` 및 Origin=`http://127.0.0.1:<port>` 필수. GET도 Origin이 존재하면 일치해야 한다.
- Host 헤더를 정확한 `127.0.0.1:<port>`만 허용하여 DNS rebinding 차단. loopback 인증을 단순히 Host만으로 대체하지 않는다. 요청 body 16 KiB, header/request timeout 및 rate limit 30req/s per server.
- CSP: `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`. `Cache-Control:no-store`, `Referrer-Policy:no-referrer`, `X-Content-Type-Options:nosniff`. HTML inline script 금지.
- 임의 fs path serve 금지, asset allowlist `/`, `/app.mjs`, `/style.css`만. 임의 RPC proxy endpoint 금지.
- read snapshot 2초 polling. count는 UI에서 serverNow로부터 경과를 계산한다. client clock으로 실제 send를 결정하지 않는다. 응답의 raw title/path를 innerHTML로 렌더링하지 않고 textContent 사용.

```js
GET /api/state -> DashboardSnapshot
POST /api/action -> Action -> DashboardSnapshot
// Action의 허용 union; 모든 mutation은 expectedRevision 필요
{type:'pause', paused:boolean, expectedRevision}
{type:'worktree', targetId:string, enabled:boolean, expectedRevision}
{type:'terminal', targetId:string, enabled:boolean, expectedRevision}
{type:'config', patch:ConfigPatch, expectedRevision}
{type:'reset-budget', targetId:string, expectedRevision}
{type:'clear-review', targetId:string, expectedRevision}
```

targetId는 worker가 발급한 opaque random ID로 snapshot에 노출, 현재 catalog에 속한 것만 허용한다. 브라우저가 보낸 worktreeId/terminalHandle을 RPC로 직접 넘기지 않는다. 오래된 revision은 409, unknown target 404, invalid payload 400, unauthorized 401, storage/unavailable 503. config edit에는 runtimeUserDataPath만 입력 가능하며 arbitrary file read endpoint는 없다.

DashboardSnapshot={revision,serverNow,appTimer:{known,enabled,ttlMs,source,readAt,reason?},connection:{state,reason?},config:(Config에서 경로는 필요시 입력값만 별도 표시),worktrees:[{id,worktreeHash,projectId,projectLabel,label,branch,enabled,effectiveEnabled,reason,terminals:[{id,title,phase,enabledOverride,effectiveEnabled,reason,cacheState,cacheStatus,indicatorOn,dueAt,expiresAt,expiredAt,expireCause,blockedReason,charged,confirmed,needsReview}]}],diagnostics:[{at,level,event,code?,target?,targetLabel?}]}. terminal의 캐시 표시 필드는 `CacheDisplayFields`와 같은 의미이며 dashboard-model이 enum·유한 timestamp만 allowlist로 복사하고 누락·불량 값은 `none`/`no-reservation`/null로 정규화한다. 영속 budget이 `needsReview`면 `cacheState`/`cacheStatus`를 `review`로 덮는다. 원시 authToken·binding·draft·screen·전체 settings·repoId·worktree 경로는 금지. 진단의 저장 로그는 target을 hashed ID(12 hex)로만 가진다. 스냅숏 생성 시 현재 catalog의 터미널로 해시를 되돌려 `targetLabel`(`워크트리 / 터미널 제목`)을 붙이고, 되돌릴 수 없으면 `targetLabel:null`이며 UI는 `#해시6자리`로 표시한다. 원문 targetId는 노출하지 않고, UI는 event를 한국어 설명으로 매핑한다. worktree는 worktreeId의 repoId(`${repoId}::${path}`)를 기준으로 프로젝트로 묶는다. 프로젝트 이름은 런타임 `repo.list`의 `displayName`을 사용하고, 조회 실패 시 같은 저장소 worktree의 label 중 사전순 최솟값을 쓴다. 화면은 `프로젝트 | 워크트리 | 세션` 3열 compact 행으로 표시하며 원시 repoId와 경로는 노출하지 않는다.

## 8. 로그·진단과 장애 처리

진단 event allowlist: bootstrap_started, runtime_connected, runtime_unavailable, settings_unknown, settings_changed, target_unsupported, epoch_armed, epoch_expired, safety_skipped, attempt_reserved, paste_accepted, submit_accepted, turn_observed, send_uncertain, policy_changed, shutdown, title_indicator, notify_failed, event_unresolved, target_reset, first_done_ignored, epoch_restored. 신규 진단의 code는 `event_unresolved`(invalid_payload | catalog_failed | no_match | no_target; 같은 (target,code)는 60초에 1회만 기록하고 dedupe Map 상한 256), `target_reset`(incarnation_changed | pty_changed | handle_changed), `first_done_ignored`(NO_FRESH_TURN — working을 보지 못한 채 받은 첫 done), `epoch_restored`(§5.6 리로드 복원; incarnation이 바뀐 복원은 `incarnation_changed`)이다. 전송 본문/화면/사용자 초안/metadata token/URL token은 기록하지 않는다. target은 hashed ID, reason은 정해진 enum으로만 기록한다. 외부 error.message를 그대로 기록하지 않고 code로 매핑한다.

host `orca.log` + 최근 200건 memory ring. binding 확인 후 `<userData>/cache-keepalive/logs/events.jsonl`에 plugin 전용 파일 기록(1 MiB×3, chmod 0600·디렉터리 0700 best effort). 앱 프로필/설정 파일에는 쓰지 않는다. Windows ACL은 chmod로 보장되지 않으므로 기존 사용자 data 디렉터리 경계를 따른다. 파일 logger 실패는 ring/host log로 대체하고 전송 상태 저장 실패와 구별한다. 알림은 동일 reason당 5분에 1회, 큰 상태 전환에만 발생; 매 tick 알림 금지.

중요 reason 코드: APP_TIMER_OFF, SETTINGS_UNKNOWN, RUNTIME_UNAVAILABLE, WRONG_RUNTIME, NO_FRESH_TURN, NO_AGENT, UNSUPPORTED_AGENT, UNSUPPORTED_HOST, NOT_CONNECTED, BUSY, INTERACTIVE_WAIT, UNKNOWN_WAIT, OUTPUT_ACTIVE, DRAFT_PRESENT, SCREEN_UNKNOWN, INPUT_QUIET_WINDOW, SCOPE_DISABLED, GLOBAL_PAUSED, CWARM_DISABLED, LIMIT_REACHED, EXPIRED, STALE_TARGET, STORAGE_FAILED, CATALOG_INCOMPLETE, PARTIAL_OR_UNKNOWN_SEND. reason별 UI 문구는 사용자가 취할 행동을 한 문장으로 설명한다. 만료 이력의 `lastBlockReason`/`expireCause`는 `contracts.EXPIRE_CAUSE_REASONS`(= 위 목록에서 EXPIRED·NO_FRESH_TURN·PARTIAL_OR_UNKNOWN_SEND을 제외한 값)만 허용하고, 임의 문자열·초안·제목은 저장하지 않는다.

최소 사용 권한 미허용/SQLite 미지원이어도 명령 등록과 diagnostics는 살아 있어야 한다. unhandled promise rejection을 남기지 않으며 한 대상 오류로 다른 상태 조회까지 멈추지 않는다. 단 runtime/profile 설정 신뢰 실패는 전체 전송을 중단한다.

## 9. 바로 위임할 작업 명세

### 9.1 공통 계약·모델·파일 소유

2026-09-29 17:21 KST에 get_model_availability로 확인한 각 역할 next:

| 역할 | profileId | model |
|---|---|---|
| 구현 | worker-commandcode-goat | commandcode/deepseek--deepseek-v4.1-flash |
| 검토 | role-reviewer | opencode-go/deepseek-v4.1-flash |
| 검증 | role-verifier | devin/claude-opus-5-5-medium (도구 next가 반환한 선택값) |

실제 실행 직전에 지휘자가 다시 availability를 확인하고 당시 next를 사용한다. 이 세션에서는 워커를 생성하지 않았다. 각 작업 제목은 `🔧[OKAP-D1C9] B : 설정 계약 구현` 형식. 검토/검증은 🔍/🧪. 생성 label은 `{"작업상태":"⏸️ 대기중","작업상태.색상":"violet"}`. 시작·완료 label 운영은 지휘자가 맡는다.

아래 모든 작업의 공통 조건:

- **입력**은 이 DESIGN의 지정 절과 명시된 소스/심볼. 설계 결정은 여기에서 고정하고 워커에게 코드베이스 전체 재조사를 맡기지 않는다.
- **수정 범위**는 각 항목의 소유 파일만(대응 test 포함). 다른 파일·DESIGN.md·Orca 소스·`.git`·dependencies·배포 제외. 충돌 또는 계약 누락을 발견하면 임의 수정 대신 지휘자에게 보고한다.
- 모든 테스트는 Node 24.x, `node --test <명시 경로>`. 부작용 test는 tmpdir/fake clock/fake socket, 실제 Orca·실제 사용자 terminal 접근 금지. fixture는 각 test 안에 작성하거나 P가 만든 공용 fixture를 P 완료 후 사용.
- **보고 형식 R**: `작업 ID / 변경 파일 / 구현 export와 계약 / 실행한 명령과 pass·fail 수 / 남은 한계·미실행 항목 / 후속 작업에 필요한 정보`. 완료 기준 충족이면 `[PASEO_DONE]`, 선행/계약 대기는 `[PASEO_WAIT]`. 테스트가 없으면 없다고 명시한다.
- integration 담당은 지휘자. 각 worker는 자신의 파일만 수정한다. 작업명세의 선행 관계에 없는 파일을 import해야 한다면 먼저 계약을 확인받는다.

### B — 설정과 타입 계약 고정

- 단일 목표: §5–§7의 공통 데이터 계약과 validator 구현.
- 입력: §5.2, §5.3, §6, §7.4; Orca 수정/추가 조사 불필요.
- 소유: `src/contracts.mjs`, `src/config.mjs`, `test/config.test.mjs`. 제외: 상태 저장·스케줄·I/O.
- 방향: JSDoc typedef, DEFAULT_CONFIG, parseConfig/parseConfigPatch, Action shape 및 reason enum. 알 수 없는 field/type/range/control char 거절. B가 다른 모듈을 import하지 않음.
- 선행: 없음. 완료: §6의 모든 타입 이름/shape 사용 가능, JSON defaults round trip, 경계값 reject, secret의 snapshot 제외 shape 명시.
- 검증: `node --test test/config.test.mjs`; `node --check src/contracts.mjs`. 보고: R, 특히 export 목록.

### C — 같은 런타임의 metadata 탐색

- 단일 목표: userData 경로와 정확한 parent runtime binding을 해석.
- 입력: §4.1; S03,S07, `getDefaultUserDataPath`, `getRuntimeMetadataPath`.
- 소유: `src/runtime-location.mjs`, `test/runtime-location.test.mjs`. 제외: socket, settings, recursive directory scan.
- 방향: §6 시그니처, inject readFile, explicit override 우선; transports의 unix/named-pipe만 허용; malformed metadata·pid 불일치에 typed error. token은 return binding에만 포함하고 error에 넣지 않음.
- 선행: B. 완료: Linux/macOS/Windows 후보, scrubbed env, wrong parent, token 누락, binding change 검증.
- 검증: `node --test test/runtime-location.test.mjs`. 보고: R, 지원 경로/fallback 목록.

### D — 줄단위 RPC transport

- 단일 목표: §4.2 envelope client 구현.
- 입력: S08, Orca `sendRequest`, runtime-rpc-envelope; §6 createRpcClient.
- 소유: `src/rpc-client.mjs`, `test/rpc-client.test.mjs`. 제외: method별 정책·재시도·discovery.
- 방향: 호출당 net connection, partial UTF-8, keepalive, matching id/runtimeId, size/idle/absolute limit, abort cleanup. write 여부 기반 error 필드. mutation 재전송 없음.
- 선행: B. 완료: 성공/서버 오류/EOF/mismatched ID/runtime restart/fragmentation/oversize/abort/keepalive 무한 연장 방지 테스트 통과.
- 검증: `node --test test/rpc-client.test.mjs`. 보고: R, error mapping 표.

### E — 앱 타이머 설정 읽기

- 단일 목표: 활성 profile의 timer 설정을 읽기 전용으로 반환.
- 입력: §4.4, S18–S22; `profileStateDatabaseFile`, DB schema/document validation.
- 소유: `src/orca-settings.mjs`, `test/orca-settings.test.mjs`. 제외: UI·쓰기·migration·runtime settings.get.
- 방향: 주입 가능한 DatabaseSync, profile/index 이중 확인, SQLite schema3/domain1/hash, DB-less JSON의 .settings. fail closed. 짧은 read transaction/close 보장.
- 선행: B,C. 완료: 실제 임시 SQLite+WAL에서 설정 변경을 읽고 DB 미존재/권한/손상/미래 schema/잘못된 hash/profile switch를 검증. 기존 JSON true/DB false이면 false.
- 검증: `node --test test/orca-settings.test.mjs`. 보고: R, read-only 검증과 SQLite feature probe 결과.

### F — 정책과 전송 journal 영속화

- 단일 목표: plugin storage의 단일 state-v1 repository 구현.
- 입력: §5.3, S04 host storage 응답 `{value}`/`{ok:true}`, §6 state-store exports.
- 소유: `src/state-store.mjs`, `test/state-store.test.mjs`. 제외: 예약 계산·RPC·다른 파일 migration.
- 방향: load 검증, mutation 직렬화/revision, 전체 state 240 KiB 상한, off 즉시·on 저장 후, reservation-before-write, budget/needsReview 보존. failed storage는 전송 허용하지 않음.
- 선행: B. 완료: 동시 토글 lost update 없음; reserve→crash→reload 차단; duplicate confirm idempotent; explicit zero-byte refusal만 budget 복원; cap0 지원.
- 검증: `node --test test/state-store.test.mjs`. 보고: R, persisted 예시(비밀 없음).

### G — 진단 로그

- 단일 목표: bounded/redacted 진단 sink 구현.
- 입력: §8, §6 diagnostics 시그니처.
- 소유: `src/diagnostics.mjs`, `test/diagnostics.test.mjs`. 제외: 실제 사용자 경로 읽기·알림 throttle 정책(조정기 담당).
- 방향: allowlist fields, target hash, 200 ring, optional JSONL 1MiB×3, fs failure fallback. close idempotent.
- 선행: B. 완료: 임의 token/draft/url/error payload가 로그에 안 남고 rotation/permission failure 작동.
- 검증: `node --test test/diagnostics.test.mjs`. 보고: R, redaction 대상.

### H — 터미널 관측 adapter

- 단일 목표: RPC facts를 검증된 Target/Catalog/Observation으로 변환.
- 입력: §4.3, §5.1, §5.5의 read 부분, S04–S06,S09,S10,S15,S24.
- 소유: `src/terminal-observer.mjs`, `test/terminal-observer.test.mjs`. 제외: send·상태 머신·주기 polling.
- 방향: list/show/agentStatus/read typed wrapper, pane+worktree 정확 join, unknown wait/screen을 unknown 유지; context handles join으로 고유 worktree만 반환. title heuristic 없음.
- 선행: B,D. 완료: 같은 branch 다른 worktree, multi-pane, null mainAgent, missing agentIdentity, unsupported host, truncated list, current context 변화 테스트 통과.
- 검증: `node --test test/terminal-observer.test.mjs`. 보고: R, 필드 누락 처리 표.

### I — 순수 epoch 스케줄러

- 단일 목표: §5.4 상태 머신 구현.
- 입력: §5.3 budget read shape, §5.4, §6 reducer/Decision 계약.
- 소유: `src/scheduler.mjs`, `test/scheduler.test.mjs`. 제외: timer·Date.now 직접 사용·fs/RPC.
- 방향: 전달된 clock만 사용, first done 미예약, working→done·dedupe·generation fencing·expiry·self-turn·policy invalidate. reason을 enum으로 반환.
- 선행: B. 완료: 300000/3600000 TTL 경계, repeated done, main done+child working, pause/restart/clock gap, self-cycle cap, due tick race 시 epoch당 1회 예약 검증.
- 검증: `node --test test/scheduler.test.mjs`. 보고: R, 상태 전이 테스트 목록.

### J — guarded paste/submit 프로토콜

- 단일 목표: §5.5의 2단계 전송을 독립 adapter로 구현.
- 입력: §4.3 send params, §5.5, S11–S16; `assertTerminalAgentSendable`은 working을 허용한다는 제약.
- 소유: `src/guarded-send.mjs`, `test/guarded-send.test.mjs`. 제외: 상한 reset·스케줄 예약·HTTP·Esc/초안 삭제·agentPrompt.
- 방향: assertAllowed/generation→journal reserve→guarded paste→500ms+draft exact match→fresh checks→guarded Enter. typed refused/uncertain. 어떤 timeout에서도 재전송 금지. 요청에는 desktop client.
- 선행: B,D,F,H. 완료: shell/no-agent/permission/mobile-lock 거절, 중간 policy off, draft 변경·unknown screen, paste 응답 유실, Enter 응답 유실에 불필요한 Enter/두 번째 paste 0건. post-paste abort는 review 유지.
- 검증: `node --test test/guarded-send.test.mjs`. 보고: R, 각 fault의 송신 frame 수.

### K — 인증된 dashboard HTTP 서버

- 단일 목표: §7.4 루프백 서버 구현.
- 입력: §6 startDashboard, §7.4 request/response/Action 계약. snapshot/dispatch는 stub 주입.
- 소유: `src/dashboard-server.mjs`, `test/dashboard-server.test.mjs`. 제외: UI 파일·RPC·실제 정책 mutation.
- 방향: port0/token/Host+Origin+Bearer/CSP/asset allowlist/body bounds, close cleanup. URL 외부 전송 없음.
- 선행: B. 완료: missing/wrong token, cross-origin, DNS rebinding Host, traversal, oversize/unknown Action, revision conflict의 status 및 무부작용 확인.
- 검증: `node --test test/dashboard-server.test.mjs`. 보고: R, HTTP 보안 case 결과.

### L — 대시보드 화면

- 단일 목표: snapshot과 Action을 사용하는 UI 구현.
- 입력: §7.3–§7.4, 고정 JSON 예시를 test 내부 구성. 다른 코드 조사 불필요.
- 소유: `ui/index.html`, `ui/app.mjs`, `ui/style.css`, `test/dashboard-view.test.mjs`. 제외: server·API 변경·외부 library.
- 방향: app.mjs에서 pure `formatRemaining`/`toViewModel` export하고 DOM bootstrap은 browser 환경에서만 호출. token fragment/sessionStorage, authenticated polling, explicit 저장, off scope와 effective 상태 구분, targetId·revision 사용, textContent만.
- 선행: B. 완료: fake snapshot에 만료/일시정지/review/unsupported/no-runtime 표시, keyboard label·테마·연결 끊김 처리. 실제 DOM 시각 검증은 S가 수행.
- 검증: `node --check ui/app.mjs`; `node --test test/dashboard-view.test.mjs`. 보고: R, 브라우저에서 확인해야 할 항목을 분리.

### M — Orca 커맨드 adapter

- 단일 목표: 무인자 커맨드 다섯 개를 controller 동작에 연결.
- 입력: §7.1, S01,S04,S23,S24, §4.3 browser schema.
- 소유: `src/commands.mjs`, `test/commands.test.mjs`. 제외: coordinator·manifest·UI.
- 방향: currentWorktree callback이 null이면 무변경, pause/resume idempotent, browser.tabCreate placement=server/navigation=host, 실패 URL 알림. custom runtime 미해결에서도 URL 반환 가능.
- 선행: B,H,K. 완료: registration ID 일치, ambiguous target 무토글, duplicate pause, browser 오류 fallback, handler 30초 내 완료(테스트 timeout은 더 짧게).
- 검증: `node --test test/commands.test.mjs`. 보고: R, command→Action mapping.

### N — 실행 조정기

- 단일 목표: 이미 완료된 adapter를 이벤트/tick lifecycle로 연결.
- 입력: §5.4–§6, B/E/F/H/I/J의 export 결과. 지휘자가 이 계약 목록과 테스트 결과를 함께 전달.
- 소유: `src/coordinator.mjs`, `test/coordinator.test.mjs`. 제외: adapter 재설계·main·UI·manifest.
- 방향: background bootstrap, event queue, generation invalidation, 단일 tick, observation concurrency3/send1, 60초 host heartbeat, profile/runtime switch reset, stop/abort, public snapshot mapping. on/off→in-flight sender의 assertAllowed 최신값 보장.
- 선행: C,D,E,F,G,H,I,J. 완료: 모의 event→epoch→due→submitted→working→done, 이벤트가 RPC 결과보다 먼저 도착하는 순서, pause mid-send, restart uncertain, tick 중첩 없음, stop 후 쓰기 없음.
- 검증: `node --test test/coordinator.test.mjs`. 보고: R, 타이머/구독 정리 검증.

### O — 플러그인 진입점과 패키지

- 단일 목표: 모듈들을 로드 가능한 plugin으로 묶기.
- 입력: §7.2 manifest, S02,S03, M/N/K의 완료 계약.
- 소유: `main.mjs`, `orca-plugin.json`, `package.json`, `.gitignore`, `test/activation.test.mjs`. 제외: src/ui·배포·npm dependencies.
- 방향: package type=module, engines node>=22.5(node:sqlite 필요, 개발·테스트는 Node 24), scripts test=`node --test`, default activate와 named deactivate, 기능 probe와 capability 확인, activate는 등록 뒤 즉시 반환. 무한 loop await 금지.
- 선행: K,L,M,N. 완료: fake orca에서 10초 내(목표 1초) 준비, 명령/이벤트 1회 등록, deactivate 2회 안전, unknown SQLite/없는 runtime에도 status 명령 유지. main import만으로 부작용 없음.
- 검증: `node --test test/activation.test.mjs`; `node --check main.mjs`; `npm test`. 보고: R, manifest 전체와 activation 시간.

### P — 가짜 런타임 통합 fixture

- 단일 목표: 실제 Orca 없이 동일 wire/host API로 통합 재현할 harness 구현.
- 입력: §4 wire·§5 state·§10 scenario 및 O 완료 결과. 소스 전체 탐색 불필요.
- 소유: `test/fixtures/fake-runtime.mjs`, `test/fixtures/fake-host.mjs`, `test/integration/keepalive.test.mjs`, `scripts/demo.mjs`. 제외: production 모듈·README.
- 방향: tmp socket/Windows named pipe, test-only metadata ppid, fake SQLite settings, write 기록; fake host가 handlers를 저장하고 event를 dispatch. fake clock adapter로 4분/58분 가속. dummy terminal 외부 프로세스/claude spawn 없음.
- 선행: O. 완료: §10.1 필수 시나리오 통과; demo localhost UI에서 두 workspace·다중 터미널 on/off 확인 가능; SIGINT/close에서 socket/files 정리.
- 검증: `node --test test/integration/keepalive.test.mjs`; `node scripts/demo.mjs`로 제시된 URL 확인 후 종료. 보고: R, scenario별 실제 send frame 수 및 unresolved 항목.

### Q — 설치·운영·등록 문서

- 단일 목표: 실제 구현 결과에 맞는 사용자 운영 문서 작성.
- 입력: §1/§3 제한·§10–§12, O/P 완료 결과, local marketplace index.
- 소유: `README.md`, `docs/TESTING.md`, `docs/PUBLISHING.md`. 제외: DESIGN·제품 코드·미확정 LICENSE·GitHub 제출.
- 방향: 개발 경로 설치, manifest 변경을 통한 reload, lazy 시작, 설정 따라감의 지연, 3회 기본 상한, 단축키/버튼, URL fallback, logs, 내부 API 의존성·usage·입력 경쟁 한계. 실기 테스트 미완료 표시.
- 선행: O,P. 완료: clean checkout에서 명령 복사 가능, publisher/license/remote 정보 미확정은 placeholder로 식별, 실험적 기능을 안정 지원으로 표현하지 않음.
- 검증: 모든 예제 JSON parse; 모든 로컬 링크 존재 검사; `node --test` 명령이 package와 동일한지 확인. 보고: R, 남은 출시 입력 목록.

### R — 독립 코드 검토

- 단일 목표: 구현이 이 계약과 안전 invariant를 지키는지 검토.
- 입력: DESIGN, B–Q 최종 diff·테스트 결과. 역할 next reviewer.
- 소유: 파일 변경 없음, 검토 보고만. 제외: 수정·배포·새 워커 생성.
- 방향: shell/permission 입력 경로, raw fallback 없음, typed draft 한계, stale target/profile, at-most-once/crash, secrets/HTTP, timer 중복·cleanup, 문서 과장 여부 우선.
- 선행: P,Q. 완료: 재현 조건·파일/라인·심각도·권장 수정이 있는 findings 또는 한계가 명시된 no findings. 결함 수정은 해당 소유자에게 지휘자가 별도 지시.
- 검증: `node --test` 1회 및 필요한 좁은 회귀 재현. 보고: R + 출시 blocker 목록. 출력 prefix 🔍.

### S — 통합·실기 검증

- 단일 목표: 완료 기준 충족 여부를 증거로 판정.
- 입력: R 결과와 수정 확인, §10의 checklist. 역할 next verifier.
- 소유: 제품 파일 변경 없음; 요청받으면 `docs/TESTING.md`에 최종 검증 결과만 추가(Q 종료 후 소유 이전). 제외: 실제 사용자 에이전트에 임의 메시지, 배포.
- 방향: 가짜 서버 suite와 UI 수동 검증; 실제 Orca 없는 현재 머신은 실기 항목을 NOT RUN으로 남긴다. 실제 설치 환경에서 사용자가 제공한 disposable Claude 세션으로만 §10.2 진행.
- 선행: R에서 blocker 해결. 완료: 자동 suite 전부 통과, 실제 E2E 실행/미실행 분리, artifact 해시·Node/OS·Orca 버전 기록, 잔여 제한 보고. 실기 미실행이면 “출시 E2E 완료”로 판정하지 않음.
- 검증: `node --test`; `node scripts/demo.mjs`; 실제 Orca가 있는 경우 §10.2. 보고: R + PASS/FAIL/NOT RUN matrix. 출력 prefix 🧪.

### 9.2 의존성 그래프와 실행 묶음

지휘자 포함 동시 4 slot이라면 구현 worker 최대 3개를 사용한다. 아래는 파일 충돌 없는 보수적 wave 예시이며 선행이 끝난 작업은 slot이 비면 먼저 시작할 수 있다.

```text
B → {C,D,F,G,I,K,L}
C → E
D → H
{D,F,H} → J
{H,K} → M
{C,D,E,F,G,H,I,J} → N
{K,L,M,N} → O → P → Q → R → S
```

| wave | 동시 작업(최대 3) | 통합 checkpoint |
|---|---|---|
| 0 | B | 타입·Action·기본값 freeze |
| 1 | C / D / F | location/transport/store 계약 확인 |
| 2 | E / H / I | settings + 관측 + 순수 scheduling 확인 |
| 3 | G / J / K | 전송 fault cases와 HTTP 인증 확인 |
| 4 | L / M / N | UI/커맨드/controller 조합 가능한지 확인 |
| 5 | O | loading smoke, 전체 unit test |
| 6 | P | wire 통합 및 시연 |
| 7 | Q | 실제 결과 기반 사용자 문서 |
| 8 | R | findings 해결 후 해당 test만 재실행 |
| 9 | S | 최종 evidence matrix |

N이 작아 보이지 않을 경우 상태 판단을 N에 추가하지 말고 I/J/H에 남겨둔다. N은 glue만 작성하며 계약 수정은 지휘자가 설계자에게 되돌린다. interface를 바꿀 때 downstream worker와 같은 파일을 동시에 수정하지 않는다. 지휘자는 매 checkpoint의 실제 output을 다음 작업 입력에 첨부한다.

## 10. 검증 기준과 실행 절차

### 10.1 현재 머신에서 가능한 자동/가짜 E2E

가짜 서버는 단순 `rpc.call` stub만이 아니라 실제 node:net newline wire를 파싱한다. metadata와 SQLite fixture는 tmpdir에 만들고 local parent pid를 fixture 의존성으로 넘긴다. UI는 실제 loopback HTTP를 쓰되 target PTY는 메모리의 입력 buffer다. send text가 들어오면 bracket frame을 해석해 draft를 갱신하고 Enter 시 submit 기록만 만든다. 어떤 shell/claude 명령도 실행하지 않는다.

fake runtime의 지원 methods: terminal.list, resolvePane, show, agentStatus, read, send, browser.tabCreate. 모든 요청 token 검증. fault injection은 method/phase/횟수별로 result false, 응답 지연/유실, EOF, malformed JSON, wrong runtimeId, permission/working/pty 교체를 설정할 수 있어야 한다. fake host는 storage 응답 wrapper와 commands.register/events.on, grantedCapabilities, log를 실제 plugin 계약처럼 제공한다. store 지연/실패·worker restart를 재현한다.

| 시나리오 | 필수 기대 결과 |
|---|---|
| timer=false, true 전환 | false에서 send 0건. true만으로 기존 idle에 즉시 send 안 함. 이후 working→done에서 예약. |
| TTL=5m / 1h | done+240000 / done+3480000 직전 0건, due에서 paste 1 + Enter 1. grace 마감 후 0건. |
| 반복 done 및 이벤트 순서 | duplicate done이 due를 늦추지 않음; 늦게 온 working/done 무시; 1 epoch에 paste≤1. |
| 자체 keepalive 순환 | working→done으로 새 epoch 생성; 자체 turn은 charged 유지; 기본 3회 후 4번째 0건; 0 상한이면 계속. 비자체 fresh working이 오면 charged=0으로 자동 reset되어 다시 3회 가능. |
| 사람 초안/질문 | preflight draft/permission/agentWait/waiting에서 0건. paste 후 다른 draft면 Enter 0건+review. |
| busy/agent 종료 | status=working은 host guard가 허용해도 plugin에서 차단. shell로 전환 시 no-agent guard 때문에 Enter 0건. |
| 설정 중간 off | paste 전 발견하면 0건, paste 후 발견하면 Enter 0건+review. 앱 저장 전 지연은 fixture에서 별도 재현하여 한계 확인. |
| 워크트리/터미널 scope | W1 off, W2 on이면 W2만. terminal on이어도 부모 off 우회 안 함. 앱 활성 worktree가 W1이어도 W2 local terminal send 가능. |
| quiet 출력 | lastOutputAt+2499ms 금지, +2500ms 허용. null/future lastOutputAt 금지. observed draft 제거 후 quiet window 적용. |
| lifecycle 변경 | pane 동일/PTY 변경, handle 교체, runtimeId/parent pid 변경, profile switch, removed 이벤트 시 기존 reservation 무효. |
| RPC 오류와 재시도 | malformed/mismatch/timeout은 fail closed. paste/Enter response drop 뒤 같은 mutation 재전송 0건. |
| crash recovery | reserve 저장→write 직전 crash도 review. write 후 crash도 review. 재시작 자체로 budget reset/과거 epoch 전송 없음. |
| 전송 중 pause/close | 늦은 async callback이 Enter를 예약하지 않음. 이미 host에 도착한 bytes는 취소할 수 없다고 상태 표시. |
| 절전/clock jump | 다수 due 대상이 있어도 wake 시 burst 0건; 새 turn 대기. |
| SQLite 권위 | JSON enabled=true, DB enabled=false이면 전송 0건. WAL 변경 인식. 미지원 schema·hash 오류·읽기 권한 없음 전송 0건. |
| host heartbeat | fake host idle reap model에서 5분보다 먼저 host.call이 발생; dashboard 닫혀도 loop 유지. |
| unknown runtime shape | missing identity/agentWait/screen/host scope 또는 목록 truncation을 safe로 승격하지 않음. |
| 루프백 HTTP | 잘못된 token/Host/Origin/oversize/unknown target/revision은 mutation 0건. 오류 응답에 token/draft 없음. |
| 대시보드 | 두 워크트리·동명 branch·split terminal 각각 토글, effective reason/카운트다운/상한/재연결 오류 표시. |

명령:

```sh
node --version
node --test
node scripts/demo.mjs
```

`demo.mjs`는 별도 test dependency로 짧은 TTL을 주입하며 실제 userData를 검색하지 않는다. 출력된 localhost URL을 열고 scope 버튼, 전역 pause, 설정 편집, 불확실 전송 확인 상태를 검증한다. 종료 후 서버 socket이 닫히고 다음 실행에서 다른 token을 사용하는지 확인한다. 프로덕션에 fast TTL 옵션을 남기지 않는다.

### 10.2 실제 Orca가 있는 환경에서 필요한 E2E

이 머신에서는 **NOT RUN**이다. 실제 검증은 별도 disposable workspace/Claude 대화에서 수행하고 모델 사용량이 발생함을 이해한 상태로 진행한다. 검증자가 agent-launched Orca를 쓰는 경우 Orca AGENTS.md의 `ORCA_BACKGROUND_LAUNCH=1` 및 비가시 창/CDP 원칙을 따른다. 개인 데스크톱의 포커스를 자동화로 빼앗지 않는다.

1. manifest/package 정합성을 확인하고 Orca 설정 → Plugins → Development에 이 저장소 절대 경로를 추가한다. 권한 확인 후 command에서 Dashboard 실행. 앱 시작만으로 worker가 자동 기동하지 않는 점 확인.
2. 실제 worker의 process.versions, node:sqlite feature probe, metadata pid=parentPid 확인. 기본 경로와 custom userData override 각각 smoke. sqlite unavailable이면 명확한 disabled 진단이고 전송이 없어야 한다.
3. 앱 “Settings → Agents → Prompt Cache Timer”를 끈 상태에서 메시지를 한 번 완료시키고 전체 TTL 이상 기다려 자동 전송 0건 확인. 켠 뒤 fresh turn 완료시키고 renderer 표시와 dashboard 예상 countdown의 차이를 기록한다(정확 일치 합격 조건으로 삼지 않음).
4. 로컬 W1/W2와 W1의 split terminal 두 개를 만든다. W1 off/W2 on 및 terminal 단독 off를 각각 확인한다. W2가 비활성 워크트리여도 승인된 대상만 keepalive된다. dashboard/browser 열기가 의도한 Orca desktop에 나타나야 한다.
5. 5분 TTL에서 fresh 완료 뒤 약 4분에 기본 메시지 정확히 1개, 짧은 응답, 다음 epoch 예약 확인. 3회 뒤 limit 중지. explicit reset 후에는 다음 완료부터 시작. 1시간 TTL은 가속 unit test와 별도로 실제 약 58분 대기 test가 필요하며 생략하면 NOT RUN.
6. Claude 입력창에 초안을 남기고 due를 넘긴다. 자동 Enter가 없어야 한다. 권한 질문/AskUserQuestion/plan approval 표시 중 전송 0건. 인터랙티브 메뉴 종류별 실제 화면 fixture를 확보하며 지원되지 않는 경우 기능을 제한한다. 검사와 Enter 사이의 레이스가 원자적으로 해결됐다고 주장하지 않는다.
7. 동일 PTY를 mobile에서 조작하여 desktop input lock 상태에서 전송이 거절되는지 확인한다. RPC client가 viewport/floor를 탈취하지 않아야 한다.
8. due 근처에 전역 pause, terminal off, 앱 timer off를 각각 시험한다. plugin pause는 후속 write 금지, 앱 off는 디스크 저장 지연을 측정해 기록. 설정 저장 이전의 메모리 상태는 플러그인이 볼 수 없음을 문서와 대조.
9. Orca restart, worker 재기동, terminal 종료·재생성, profile switch, sleep/wake를 확인. 과거 due의 catch-up 메시지/중복 Enter가 없어야 한다. journal 미완료는 review로 복원.
10. 대시보드를 닫고 5분 이상 지나도 worker heartbeat 유지, 앱/플러그인 disable 시 서버·timer 종료. main.mjs 수정만으로 worker가 재시작되지 않는 known behavior에 따라 manifest version 변경 또는 disable/enable 후 재검증한다.
11. 다른 웹 origin에서 loopback API 요청, console/log/history/network에 token 유출이 없는지 확인. 대시보드에는 사용자 초안·전체 settings·RPC authToken이 없어야 한다. fragment token은 브라우저 페이지를 열기 위한 bearer secret이므로 공유하지 않는다.
12. macOS/Linux/Windows에서 개발 로드·path/socket 또는 pipe·브라우저 열기·SQLite smoke. 각 OS별 실행하지 않은 항목은 미지원 가능성으로 기록한다. SSH/VM/native chat은 의도적으로 unsupported 표시가 나와야 한다.

완료 판정: 자동 테스트 전부 pass + R blocker 0 + 실제 E2E 중 지원 platform의 필수 항목 pass. 실제 Orca 없이 완료할 수 있는 범위는 “가짜 RPC 통합 검증까지”이며 출시 E2E 완료와 구분한다.

## 11. 개발 로드와 마켓플레이스 등록 계획

개발 단계에는 build/install 명령이 필요 없다. 저장소 루트의 `orca-plugin.json`, main.mjs, src, ui가 그대로 배포물이다. `package.json` dependencies/devDependencies를 비워두고 `npm test`만 제공한다. main.mjs 변경 시 기존 worker가 유지될 수 있으므로 manifest version bump 또는 plugin disable/enable로 새 worker 사용을 확인한다. 앱에 수정 사항을 반영했는지 process start/diagnostic version으로 확인한다.

> 결정(2026-09): 마켓플레이스 등록은 하지 않는다. 커뮤니티 플러그인으로 공개 Git 저장소에서 Orca "Install plugin" > "Git URL"(`<URL>#<tag>`)로 직접 설치한다. 아래 marketplace 계획은 참고용 기록으로만 남긴다. 현행 절차는 docs/PUBLISHING.md를 따른다.

커뮤니티 marketplace는 별도 Git 저장소의 루트 `orca-marketplace.json`로 제공 가능하다. 실제 게시자/remote가 확정되면 다음 placeholder를 치환한다.

```json
{
  "name": "Community Keepalive Plugins",
  "owner": "PUBLISHER_ACCOUNT",
  "plugins": [
    {
      "id": "runaticmoon.cache-keepalive",
      "source": {
        "kind": "git",
        "url": "https://github.com/PUBLISHER_ACCOUNT/orca-keepalive-plugin.git",
        "ref": "v0.1.0"
      },
      "description": "Configurable keepalive messages for idle Claude terminals in Orca.",
      "categories": ["utilities", "agents"]
    }
  ]
}
```

1. 실제 publisher를 manifest/marketplace id 양쪽에 동일하게 적용. author/repository는 실제 값이 생긴 뒤 추가. LICENSE는 저장소 소유자가 선택; 참고 도구 코드를 복사한다면 해당 라이선스 고지 별도 확인.
2. S의 검증 결과와 알려진 제한을 README/release notes에 기록. release tag `v0.1.0`의 commit에 manifest와 실행 파일 전체 포함. 설치 시 npm install/build hook에 기대지 않는다.
3. 커스텀 marketplace의 Git URL/ref를 Orca Plugins의 marketplace 관리에 추가한 뒤 목록·capability·설치·업데이트·제거 smoke. URL 접근/인덱스 검증 실패를 진단한다.
4. 공식 `stablyai/orca-plugins` 인덱스에도 등록하려면 동일 entry의 PR을 준비할 수 있으나 등록 정책/maintainer 수락은 이 소스만으로 확정할 수 없다. community slug를 유지하며 `stablyai` publisher, `orca-` id, official category를 자칭하지 않는다.
5. marketplace는 URL+named ref를 정확한 commit으로 resolve한다(S25). tag만 올려 놓고 index ref/manifest version을 다른 버전으로 두지 않는다. 공식 PR merge/배포/실제 설치는 현재 설계 작업에 포함되지 않는다.

## 12. 한계, 상위 API 제안, 남은 질문

### 12.1 현재 설계에서 해결하지 못하는 사항

- 내부 RPC·SQLite schema에 의존하므로 pluginApi 1만으로 호환성이 보장되지 않는다. 버전 상승 시 shape/capability 검사를 통과하지 못하면 중단해야 한다.
- 렌더러 timerStartedAt과 실제 provider cache TTL을 읽지 못한다. 완료 이벤트가 캐시 수명과 일치한다는 보장은 없고 긴 generation 동안 실제 cache가 더 일찍 만료될 수 있다. keepalive 전송은 cache hit 증거가 아니다.
- 설정 변경은 저장 debounce 및 queue 지연만큼 늦게 보인다. 디스크를 다시 읽어도 UI 메모리 상태와 send를 원자적으로 묶을 수 없다.
- screen draft는 heuristic이며 native chat composer·에디터형 입력·일부 TUI 모드에서 누락될 수 있다. paste 후 draft exact-match는 섞인 초안 제출 위험을 낮추지만 마지막 검사 이후의 레이스를 없애지 못한다.
- client.type=desktop은 RPC의 조건 필드이며 실제 foreground exclusive 입력 lease가 아니다. 다른 사람이 desktop에서 같은 PTY를 만지는 것을 잠그지 않는다.
- hooks disabled, 설치 시 이미 idle, worker가 꺼진 동안 종료된 turn은 예약하지 않는다. 앱 시작 시 자동 start 이벤트가 없으므로 명령이나 새 이벤트까지 worker가 없다. 60초 heartbeat는 기동 후 생존만 해결한다.
- self attempt의 15초 확인 창과 겹친 다른 자동화/사람의 turn은 자체 turn으로 오인될 수 있다(그 경우 budget이 reset되지 않는 보수적 방향). 비자체 turn은 사람/자동화 구분 없이 budget을 reset한다.
- supported local desktop 범위 밖은 읽기 전용 표시. 원격 지원은 호스트 clock·profile 설정 소유권·입력 안전·브라우저 loopback 경로를 추가 설계해야 한다.
- hook/화면 및 RPC read가 늦거나 조용한 창이 없으면 해당 epoch를 놓치는 것이 정상적인 보수적 동작이다. cache warm 유지보다 사용자 입력 보호를 우선한다.
- 대시보드의 만료 사유는 실제 원인이 아니라 **마지막으로 기록된 전송 차단 사유**다. DRAFT_PRESENT는 Orca가 Claude Code의 흐린 프롬프트 제안을 화면 초안으로 오판해도 기록될 수 있다. 화면 문구는 이를 “마지막으로 기록된 전송 차단 사유입니다.”로 한정한다.
- 만료 시각은 관측한 작업과 설정 TTL 기준의 예상이며 실제 Anthropic 캐시 만료가 아니다(§12.1 두 번째 항목). scheduler는 실제 만료 10초 전에 EXPIRE를 반환하므로 `EXPIRED` phase와 예상 만료 시각은 같은 순간이 아니다.
- 저장 기록도 없고 RPC 투영 title에도 알려진 prefix가 나타나지 않는 옛 customTitle 잔여물은 식별할 수 없어 자동 정리하지 않는다. 이전 업데이트에서 이미 사라진 만료 이력도 복구할 수 없다. v2 저장소는 이전 버전으로 다운그레이드하면 복원되지 않는다.

### 12.2 요구 수준을 높이기 위한 Orca 상위 변경 제안(별도 프로젝트)

필요한 최소 계약은 host-owned `terminal.keepaliveStatus`와 `terminal.keepaliveSend`다. 이것은 현재 존재하는 method가 아니라 **제안**이다.

```js
// read
{terminal, processIncarnation, profileId, enabled, ttlMs, cacheEpoch,
 cacheStartedAt, combinedState, mainState, hasDraft, lastHumanInputAt,
 humanInputRevision, lastOutputAt, supported}
// conditional mutation
{terminal, expectedProcessIncarnation, expectedCacheEpoch,
 expectedHumanInputRevision, expectedSettingsRevision, message}
// result
{accepted, reason, attemptId, turnStarted}
```

send handler가 settings enabled/current epoch/idle/permission/draft/input revision/PTY binding을 검사하고, guarded paste+submit 동안 입력 권한을 중재하며, agentPrompt를 지원하지 않으면 raw fallback 없이 거절해야 한다. renderer 전용 timer를 host로 이동하거나 동일 epoch 이벤트를 공개해야 한다. plugin에 background activation trigger와 worker↔panel channel을 제공하면 local HTTP/keepalive heartbeat 우회도 제거할 수 있다.

### 12.3 지휘자가 확정할 항목

설계와 mock 구현을 시작하는 데 추가 답변은 필요 없다. 다음은 출시 범위를 결정하는 잔여 사항이다.

1. 기본 3회 budget과 명시 reset, local Claude-only v0.1 범위를 수용할지. 무제한 사용은 사용자가 0으로 변경할 수 있다.
2. 초안 경쟁/설정 저장 지연이 허용되는 실험적 출시인지, §12.2 host API를 선행해야 하는지. **완전한 입력 보호가 필수이면 현재 API만으로 출시 완료 판정을 내릴 수 없다.**
3. 실제 publisher slug, Git remote, 라이선스, release tag와 marketplace 소유자.
4. 실기 테스트를 수행할 Orca desktop OS/버전과 disposable Claude 세션. 현재 설계 조사로는 런타임 성공·cache 적중을 주장할 수 없다.

## 13. 이 설계 작업의 검증 기록

- 로컬 source/기존 test/manifest/marketplace 계약을 읽어 잠정 결정을 재검토했다. 특히 설정 projection 누락, SQLite authority, guarded-send와 agentPrompt 조합 불가, resolveActive의 추측 동작을 확인했다.
- 도구의 model availability를 조회했으며 워커 생성·제품 구현·설치·실제 터미널 전송은 수행하지 않았다.
- 문서의 JSON fenced block 4개 parse 통과. 소스 경로·라인 인용 48개를 검사하여 누락 없음(이후 확인한 storage 상한 인용 1개 추가). B–S 작업 ID 18개 중복 없음.
- 작업 소유 파일 41개를 검사했다. Q→S의 `docs/TESTING.md`는 명시적인 순차 인계이며 동시 소유가 아니다. 다른 중복 없음. 저장소의 `.git` 외 실제 파일은 허용된 `docs/DESIGN.md` 하나임을 확인했다.
- 문서 검사와 `git diff --check`를 수행했다. 신규 untracked 문서는 별도로 JSON/경로/소유권 검사를 수행했다. 이는 미래 제품 테스트가 실행됐다는 뜻이 아니다.
