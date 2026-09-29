# Testing Cache Keepalive

> **상태: 실제 Orca E2E NOT RUN (이 저장소 개발 환경에는 Orca 데스크톱이 없음)**
>
> 이 문서의 자동화 테스트는 모두 **가짜 Orca 런타임**(tmp 소켓 + tmp SQLite)을 사용합니다.
> 실제 Orca 데스크톱에서의 end-to-end 동작은 아직 검증되지 않았습니다. 아래
> [실제 Orca 수동 E2E 체크리스트](#3-실제-orca-수동-e2e-체크리스트)는 별도 Orca 환경에서
> 수행해야 하며, 수행 전까지는 "출시 E2E 완료"로 판정하지 않습니다.

---

## 1. 자동 테스트

요구 사항: **Node >=22.5** (이 저장소 개발 환경은 Node 24에서 확인). 추가 의존성 없음.

```sh
node --version
npm test          # = node --test
```

`npm test`는 `package.json`의 `"test": "node --test"`와 동일하며, 저장소의 모든
`test/**/*.test.mjs`를 실행합니다. 단위 테스트와 통합 테스트가 함께 돌아갑니다.

좁은 범위만 돌리려면 파일을 직접 지정합니다.

```sh
node --test test/config.test.mjs
node --test test/integration/keepalive.test.mjs
```

### 단위 테스트 (`test/*.test.mjs`)

각 모듈의 소유 테스트가 있습니다. 대표적으로:

- `config.test.mjs` — 설정 기본값·검증·경계값
- `runtime-location.test.mjs` — 런타임 metadata 경로/binding
- `rpc-client.test.mjs` — 줄단위 RPC transport/envelope/오류
- `orca-settings.test.mjs` — 활성 프로필 타이머 설정 읽기
- `state-store.test.mjs` — 영속 상태 journal/budget
- `scheduler.test.mjs` — epoch 상태 머신
- `guarded-send.test.mjs` — 2단계 paste/Enter 프로토콜 fault
- `terminal-observer.test.mjs` — RPC 관측/대상 join
- `dashboard-server.test.mjs` — 인증된 루프백 HTTP
- `dashboard-view.test.mjs` — 대시보드 순수 helper
- `commands.test.mjs`, `coordinator.test.mjs`, `diagnostics.test.mjs`, `activation.test.mjs`

### 통합 테스트 (`test/integration/keepalive.test.mjs`)

가짜 Orca 런타임 소켓·가짜 host·가짜 clock·임시 SQLite userdata 위에서 **실제
`main.mjs`의 `createPlugin`** 을 활성화해 실제 wire와 host 계약을 재현합니다. 실제
shell/claude/Orca 프로세스는 실행하지 않습니다.

**시나리오 13개:**

1. `scenario 1` — timer off는 전송 0, on 후 기존 idle도 0, 새 turn의 due에서 paste 1 + Enter 1
2. `scenario 2` — TTL 1시간은 `done + 3480s` 부근에서 전송
3. `scenario 3` — 자체 순환 3회 후 4번째 0, 비자체 turn이면 budget reset 후 재전송
4. `scenario 4a` — 입력창에 draft가 있으면 전송 0
5. `scenario 4b` — permission 상태면 전송 0
6. `scenario 4c` — agentWait 객체(대기)면 전송 0
7. `scenario 5` — paste 후 draft가 변조되면 Enter 0 + 대시보드 `needsReview`
8. `scenario 6` — W1 off / W2 on이면 활성 worktree와 무관하게 W2만 전송
9. `scenario 7` — 인증된 대시보드로 terminal을 끄면 전송 0 (잘못된 token/Origin도 차단)
10. `scenario 8` — paste 응답 유실이면 재전송 0, Enter 0, `needsReview`
11. `scenario 9` — wall clock이 1시간 점프(절전)하면 burst 전송 0
12. `scenario 10` — pause면 전송 0, resume 뒤 다음 turn부터 재개
13. `scenario 11` — 5분 이상 가상 시간 동안 `host.call(storage.get)` heartbeat 존재

각 테스트는 tmpdir/fake clock/fake socket을 쓰고 실제 사용자 터미널에 접근하지 않습니다.

---

## 2. 데모 (사람이 UI를 볼 때)

실제 Orca 없이 실제 플러그인을 가속 clock 위에서 돌리고, 대시보드 URL을 출력합니다.

```sh
node scripts/demo.mjs --speed 60 --exit-after 60
```

- `--speed 60`: 5분 TTL이 약 5초에 도달하도록 시간을 60배 가속합니다.
- `--exit-after 60`: 60초 뒤 자동 종료합니다. `SIGINT`/`SIGTERM`으로도 정리됩니다.
- 출력의 **Dashboard** URL을 브라우저로 열어 확인합니다. (가짜 Orca 브라우저가 없어
  `browser.tabCreate`가 실패하고, URL이 알림으로 표시됩니다.)
- 데모는 워크트리 2개(`wt-alpha` split 2터미널, `wt-beta` 1터미널)를 만들고
  주기적으로 working→done을 흉내내며, Enter를 받으면 자체 turn을 시뮬레이션합니다.

확인 체크리스트:

- [ ] 대시보드가 열리고 앱 타이머/연결/일시정지 상태가 보인다.
- [ ] 워크트리 토글이 켜짐/꺼짐/(기본)을 구분해 표시된다.
- [ ] 터미널 on/off/inherit가 동작하고 "실제 적용"과 사유가 함께 표시된다.
- [ ] 전역 일시정지 후 전송이 멈추고, 재개하면 다음 turn부터 재개된다.
- [ ] 예상 만료 countdown과 다음 예정/charged/confirmed가 표시된다.
- [ ] 설정 폼을 바꾸고 **저장**을 눌러야 반영된다(저장 전에는 미반영).
- [ ] (fault 주입 시) "확인 필요" 상태와 그 해제 버튼이 보인다.
- [ ] 종료 후 서버 소켓이 닫히고, 다음 실행에서 다른 token을 사용한다.

---

## 3. 실제 Orca 수동 E2E 체크리스트

DESIGN.md §10 기반. 실제 Orca 데스크톱과 disposable Claude 세션에서만 수행합니다.
자동화로 포커스를 빼앗지 말고, 모델 사용량이 발생함을 이해한 상태로 진행합니다.

1. manifest/package 정합성을 확인하고 Orca **설정 > Plugins > Development**에 저장소
   절대 경로를 추가한 뒤 권한을 승인하고 Dashboard를 연다. 앱 시작만으로 worker가
   자동 기동하지 않는 점을 확인한다.
2. 실제 worker의 `process.versions`, `node:sqlite` feature probe, metadata의
   `pid == parent pid`를 확인한다. 기본 경로와 custom userData override를 각각 smoke.
   SQLite 미지원이면 명확한 disabled 진단이 나오고 전송이 없어야 한다.
3. 앱 **Settings > Agents > Prompt Cache Timer**를 **끈** 상태에서 턴을 완료시키고
   전체 TTL 이상 기다려 자동 전송 **0건**을 확인한다. 그 뒤 타이머를 켜고 fresh
   turn을 완료시켜, renderer 표시와 대시보드 countdown 차이를 기록한다(정확 일치는
   합격 조건이 아님).
4. W1/W2 로컬 워크트리와 W1의 split 터미널 2개를 만든다. W1 off/W2 on, terminal
   단독 off가 각각 동작하는지 확인한다. W2가 비활성 워크트리여도 승인된 대상만
   keepalive된다. dashboard/browser 열기가 의도한 Orca desktop에 나타나야 한다.
5. 5분 TTL에서 fresh 완료 뒤 약 4분에 기본 메시지가 정확히 1개 전송되고 짧은 응답이
   오며 다음 epoch가 예약되는지 확인한다. 3회 뒤 limit에서 멈추고, explicit reset 뒤
   다음 완료부터 시작하는지 확인한다. 1시간 TTL은 실제 약 58분 대기가 필요하며
   생략하면 NOT RUN으로 남긴다.
6. Claude 입력창에 초안을 남기고 due를 넘긴다. 자동 Enter가 없어야 한다. 권한
   질문/AskUserQuestion/plan approval 표시 중 전송 0건이어야 한다. 검사와 Enter
   사이 레이스가 원자적으로 해결됐다고 주장하지 않는다.
7. 동일 PTY를 mobile에서 조작해 desktop input lock 상태에서 전송이 거절되는지
   확인한다. RPC client가 viewport/floor를 탈취하지 않아야 한다.
8. due 근처에 전역 pause, terminal off, 앱 timer off를 각각 시험한다. plugin pause는
   후속 write를 막고, 앱 off는 디스크 저장 지연을 측정해 기록한다.
9. Orca restart, worker 재기동, terminal 종료·재생성, profile switch, sleep/wake를
   확인한다. 과거 due의 catch-up/중복 Enter가 없어야 하고, 미완료 journal은 review로
   복원되어야 한다.
10. 대시보드를 닫고 5분 이상 지나도 worker heartbeat가 유지되는지, 앱/플러그인
    disable 시 서버·timer가 종료되는지 확인한다. `main.mjs`만 수정하면 worker가
    재시작되지 않는 known behavior에 따라 manifest version 변경 또는 disable/enable로
    재검증한다.
11. 다른 웹 origin에서 loopback API 요청이 실패하는지, console/log/history/network에
    token이 유출되지 않는지 확인한다. 대시보드에 사용자 초안·전체 settings·RPC
    authToken이 없어야 한다.
12. macOS/Linux/Windows에서 개발 로드·경로/socket 또는 pipe·브라우저 열기·SQLite
    smoke를 확인한다. 각 OS에서 하지 않은 항목은 미지원 가능성으로 기록한다.
    SSH/VM/native chat은 의도적으로 unsupported 표시가 나와야 한다.

**완료 판정:** 자동 테스트 전부 pass + 독립 검토 blocker 0 + 실제 E2E 중 지원
플랫폼의 필수 항목 pass. 실제 Orca 없이 완료할 수 있는 범위는 "가짜 RPC 통합
검증까지"이며, 출시 E2E 완료와 구분합니다.

---

## 4. 진단 로그

- 실행 중 문제가 있으면 Orca 로그와 플러그인 진단(대시보드 "최근 진단" / `<userData>/cache-keepalive/logs/events.jsonl`)
  을 확인합니다. 로그에는 고정 event allowlist와 hashed target만 기록되며, 메시지
  본문·화면·초안·authToken·URL token은 기록되지 않습니다.
- 흔한 reason 코드와 사용자 행동 안내는 대시보드 UI 문구(`ui/app.mjs`의
  `REASON_TEXT`)에 한국어로 있습니다.
