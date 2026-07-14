# code-map

> 🇬🇧 **Read in English → [README.md](./README.md)** &nbsp;·&nbsp; 🇰🇷 한국어는 아래로.

> **AI 에이전트에게 필요한 코드 조각을 *추측 없이, 좌표로* 정확히 건네줍니다.**
> *좌표만 정밀하게. 의미는 LLM이 raw를 보고 매번 새로 판정한다.*

![Node](https://img.shields.io/badge/node-%E2%89%A523.6-green)
![langs](https://img.shields.io/badge/TS%2FJS-%2B%20Python-blue)
![deps](https://img.shields.io/badge/runtime%20deps-1%20(oxc--parser)-brightgreen)
![tool](https://img.shields.io/badge/tools-just%20%60read%60-ff69b4)

---

## 이런 적 있으시죠? 😅

에이전트가 `createMessage`를 읽어야 해서 grep을 칩니다 — 그런데 프로바이더마다 있어서
**40개가 매칭**돼요. 어느 게 맞는지 찾으려 파일을 통째로 열고, 안 쓸 코드에 토큰을 태웁니다.
다음 턴엔 "그 함수 120번 줄이었지" 하고 기억하는데, 직전 편집이 138번으로 밀어버려서
**엉뚱한 줄을 읽고도 모릅니다.** 😱

code-map이 옆에 있으면 에이전트는 그냥:

> `read({ refs: ["anthropic.ts#createMessage", "openai.ts#createMessage"] })`
> → 두 슬라이스 정확히, **한 번의 호출**, 파일이 밀렸어도 **여전히 맞게.**

*찾기*는 `grep`이 합니다 — 그건 grep이 잘해요. **code-map은 *읽기*를 합니다:**
작고, 정확하고, 드리프트에 강하게. 그게 전부예요.

---

## 무엇을 얻나요 — 약속이 아니라 *측정값*

| | |
|---|---|
| 🎯 **조용히 틀리지 않음** | 대량 편집 후 재인덱싱 없이도 `read`는 시그니처 줄로 재앵커링: **조용히-틀린 바이트 0개** (순진한 "줄번호" 캐시는 ~100% 틀림). 맞는 코드를 주거나 *못 준다고 말할 뿐*, 절대 엉뚱한 바이트를 안 줍니다. |
| ⚡ **토큰·단계 절감** | 코딩 에이전트 배선 시(codex, 150-태스크 pass@30): **토큰 −19%, 셸 명령 −67%, 성공률 동일.** *기지(known) ref* 읽기에선 절감폭이 훨씬 큼 — grok composer-2.5-fast 30패스: **토큰 −53~60%, 검색 페이로드 −71~78%**; codex+라우팅 skill: **−34~54%**. |
| 🧭 **라우팅이 레버** | 에이전트는 스스로 `read`를 잘 안 씀(~17%). 동봉 **plugin/skill**이 그걸 시킴: discovery를 *손해*에서 **−31%**로 뒤집고(이중호출 제거), 들쭉날쭉한 사용(한 시나리오 **+61%** 손해)을 안정적 승리로(**30/30 pass**). |
| 🧩 **가볍고 drop-in** | Node + 의존성 **1개**(`oxc-parser`), 빌드 단계 없음. TS/JS **그리고** Python. MCP 서버 + 한 줄 skill — Claude·Codex·grok·Antigravity에 설치. |

> **경계에 대해 정직하게** (이 레포의 핵심): code-map은 *검색*에서 `grep`을 못 이깁니다 —
> 동급이라 grep은 그냥 쓰세요. 그리고 *어디서나* 토큰을 줄이는 마법도 아닙니다 — 기지 ref
> 읽기에선 **라우팅과 함께** 크게 이득, 이미 린한 read 과제에선 ~0, 순수 discovery에선
> skill이 라우팅하지 않으면 *손해*. 모든 수치·철회·모델/지표 주의·1-커맨드 검증기는
> **[code-map-bench](https://github.com/annyeong844/code-map-bench)** 에 있어요.

**한 줄 요약 — grep은 찾고, `read`는 읽는다.**

---

## 빠른 시작

```bash
# 1. 설치 (npm 퍼블리시 전까진 GitHub에서 바로)
npm install -g github:annyeong844/map        # `map` + `map-mcp` 제공

# 2. 에이전트가 읽을 레포를 인덱싱
cd /path/to/your-repo && map index --root .  # ./.map-index.json 생성

# 3. 에이전트에 배선 (예시)
codex mcp add code-map -- map-mcp             # Codex
claude mcp add code-map --scope user -- map-mcp   # Claude Code
```

끝 — 이제 에이전트엔 도구 하나 `read`가 생겼어요. Codex에서 **−19% / −67%** 효율 이득까지
보려면 *언제* code-map을 쓸지 한 줄로 알려줘야 합니다(아래 *실전 배선* 참고). MCP 서버는
인덱스를 자동 탐지(`.map-index.json`을 위로 훑음)하고 재인덱싱 시 자동 리로드 — 재연결 불필요.

---

## 누구를 위한 도구인가요?

### ✅ 잘 맞아요

- 코드를 많이 읽는 **AI 코딩 에이전트**(Codex, Claude Code, …)를 씀
- `grep`이 노이즈를 뱉고 읽기가 파일을 통째로 끌어올 만큼 레포가 큼
- **TypeScript / JavaScript 또는 Python** 작업
- 코드가 에이전트 아래에서 바뀌어도 **읽기가 계속 맞기를** 원함

### ❌ (아직) 맞는 도구가 아니에요

- 더 나은 *검색*을 원함 — `grep`/ripgrep이 이미 동급, code-map은 *읽기*용
- 파일 1~2개짜리 프로젝트 — 읽기 절감이 안 보임
- "auth는 어디서 처리되지?" 같은 개념 검색 — 그건 임베딩(여기선 *측정된* 비-목표)

---

## 유일한 도구: `read`

```bash
map read "alias-map.ts#buildAliasMap"        # 경로-스코프 이름 → 정확한 슬라이스
map read buildAliasMap                       # 맨이름 (모호하면 에러)
map read withRetry --snippet "req.copy()"    # 심볼 *안의* char 범위
map read --refs "getModel,createMessage,withRetry"   # batch: 여러 심볼, 한 콜
map stats                                    # 인덱스 개요
```

기계 출력은 `--json`. **검색은 직접 `grep`으로** — 찾은 `file:line`이나 심볼 이름을 `read`에
넘기세요. MCP 도구로도 같은 `read`(단일 `ref`, batch용 `refs` 배열, 선택적 `snippet`).

---

<details>
<summary><b>🧪 정직한 성적표 — 남긴 것, 데이터가 자르게 한 것</b></summary>

code-map은 넓게 시작했고(locate, grep, graph, hotspots, 시맨틱 검색) **`grep` + 강한
에이전트와 정직하게 벤치마크**(Sonnet/Opus, 헤드리스, 실제 레포 — `cline`, `django`,
`requests`)했어요. 측정이 대부분을 먹었고, 표면을 거기에 맞춰 잘랐습니다. *베이스라인을
이긴 것만 남긴다* — 그게 핵심이에요.

| 능력 | `grep` + 강한 에이전트 대비 측정 | 판정 |
|---|---|---|
| **드리프트-안전 READ** (`read`) | 대량 churn 후 재인덱싱 없이: **조용히-틀린 바이트 0**, 94.5% 복구 vs 순진한 줄-캐시 **100% silent**. 재현됨. | **유지** |
| **드리프트-안전 EDIT** (`read --snippet`) | 인용 스니펫 → churn 후의 *현재* char 범위: **조용한 오타게팅 0** vs 순진한 방식 **100%**. | **유지** |
| **`refs` batch 토큰** | pass@30, 150 태스크, 실 plugin(codex): **effective 토큰 −18.6%, 셸 명령 −67%, pass@30 동률, MCP fail 0.** grep을 완전 대체할 때 최대(known-cross-file 토큰 −25% / 시간 −44%); 보완만 할 땐 동률/느림(discovery, multi-symbol batch). **Opus에선 손해**(native가 이미 린). | **유지** |
| **Read — turns** | 에이전트 *턴* −25–30% (K=30, 양 모델, CI가 0에서 떨어짐). | **유지** |
| **Caller 정밀도** (`code-oracle`, 별도 sibling) | blast-radius에서 **읽을 파일 31% 감소**(흔한 이름 40–75%); 타입 체커가 *어느 클래스 메서드*인지 가림. LSP 워밍업 비용. | **유지(sibling)** |
| **단발-read 토큰** | 초기 "−16–35%"는 K=5 노이즈; K=30 단발은 ~0. | 철회 |
| **검색 / `locate`** | `grep`과 **동급**(100% recall). | 제거 |
| **시맨틱 임베딩** | **더 나쁨** — 3가지로 독립 기각, grep 에이전트를 *오히려 악화*. | 안 만듦 |
| **경량 call-graph** | recall에서 **grep에 패배**(dispatch/타입에 눈멈). | 제거 |

전체 수치, round-trip 법칙, 채택 사다리, 모든 철회는
**[code-map-bench](https://github.com/annyeong844/code-map-bench)** 에 —
[RESULTS.md](https://github.com/annyeong844/code-map-bench/blob/main/RESULTS.md)(drift/edit/oracle)
+ [EFFICIENCY-CODEX.md](https://github.com/annyeong844/code-map-bench/blob/main/EFFICIENCY-CODEX.md)
(batch/cross-model/adoption). 거기 `node verify.mjs`가 커밋된 헤드라인(코덱스·Grok pass@30 top-line 포함)을
raw 실행 데이터에서 재유도하고, 재유도 못 하는 소수는 직접 표시합니다.

</details>

<details>
<summary><b>🧭 <code>read</code>가 드리프트를 견디는 법 (핵심 트릭)</b></summary>

`read(symbol)`은 이름을 한 심볼로 resolve한 뒤:

```
1. 파일 토큰이 인덱스와 일치   →  정확한 char-offset 슬라이스        [exact]
2. 파일이 변함               →  시그니처로 재앵커링 후 재슬라이스    [relocated]
3. 앵커가 여러 곳에 매칭      →  후보 위치들 반환                   [ambiguous]
4. 앵커가 사라짐             →  그렇다고 말함; 재인덱싱 권유         [anchor-lost]
```

줄번호는 밀리지만 시그니처 줄은 거의 안 밀려요. offset이 stale이면 `read`가 시그니처로
심볼을 다시 찾고 결과를 **플래그**해서 경계를 확인하게 합니다 — *조용히 신뢰하는 게 없음.*
이게 맹목적 `Read(file, lineRange)` 대비 우위예요: stale 줄범위는 엉뚱한 바이트를 주지만,
`read`는 재앵커링하거나 *못 한다고 말함.* `--snippet`은 심볼 *안의* char 범위를 주고,
이웃 심볼로 절대 새지 않아요.

</details>

<details>
<summary><b>🧱 왜 의미가 아니라 좌표인가</b></summary>

*의미*(요약)를 저장하는 지도는 그게 stale 되는 걸 막아야 해요 — 생산자, 검증자, 재생성.
해석을 저장 안 하면 그 기계장치가 사라지고, 남는 건 기계가 검증 가능한 것뿐: **좌표 인덱스**
(`path`/`line`/`charStart–charEnd`) + 그 좌표가 여전히 유효한지 말하는 **파일당 토큰 하나.**
유일한 질문 — *"이 좌표가 맞나?"* — 엔 답이 있어요. *"이 설명이 맞나?"* 는 *묻지 않습니다.*
LLM이 raw 바이트를 매 콜마다 새로 읽고 판정해요.

**좌표는 어디서 오나:** code-map은 소스 트리를 *직접* 파싱해요(외부 그래프 없음). git-추적
파일(`git ls-files`, `.gitignore` 존중) → **TS/JS는 `oxc-parser`**, **Python은 stdlib-`ast`
백엔드** — 둘 다 같은 per-file 기본형(심볼 좌표 + `searchText` 드리프트-앵커 + 콘텐츠 토큰)을
냅니다. `fanIn`(cross-file 참조 수)은 맨이름이 둘 이상으로 resolve될 때 *타이브레이크*에만 씀.
정직한 범위: namespace / `export *` / alias 임포트는 미귀속.

</details>

<details>
<summary><b>🔌 실전 배선 (설치 옵션 + 효율 이득)</b></summary>

**요구사항:** Node ≥ 23.6(TypeScript 직접 실행, 빌드 없음), 런타임 의존성 1개(`oxc-parser`);
파일 walk엔 `ripgrep`이 있으면 사용; Python은 `python3`가 `PATH`에 필요.

**설치:** `npm install -g @annyeong844/code-map`(퍼블리시 후) ·
`npm install -g github:annyeong844/map`(지금) · 또는 clone + `npm install && npm link`.
모두 `map`과 `map-mcp`를 제공.

**MCP 설정** — 클라이언트가 레포 밖에서 서버를 띄우면 인덱스를 고정:

```toml
# ~/.codex/config.toml  (또는 프로젝트 .codex/config.toml)
[mcp_servers.code-map]
command = "map-mcp"
[mcp_servers.code-map.env]
MAP_INDEX = "/path/to/target-repo/.map-index.json"
```

```jsonc
// 일반 MCP 클라이언트
{ "mcpServers": { "code-map": { "command": "map-mcp" } } }
```

**효율 이득엔 *채택*이 필요해요.** 에이전트는 스스로 grep 대신 code-map을 안 골라요
(측정: ~17%). **100% 신뢰** 채택을 주는 배선 — 택1:

- **동봉 plugin/skill (권장):** 이 레포가 `skills/code-map-retrieval/`에 라우팅 skill을
  `.claude-plugin/plugin.json` 매니페스트와 함께 동봉해 plugin으로 설치돼요.
  ```bash
  grok plugin install annyeong844/map          # Grok (또는 로컬 경로)
  claude plugin install code-map@code-map        # Claude Code (marketplace add 후)
  codex plugin add code-map@code-map             # Codex (marketplace add 후)
  # Antigravity: GEMINI.md를 ~/.gemini/GEMINI.md(전역) 또는 워크스페이스에 복사
  ```
  **discovery 이중호출 가드** 포함 — 발견은 grep으로 하고 *멈춰라*, 위에 `read` 얹지 마라 —
  3-arm 벤치에서 discovery를 손해→승리로 뒤집은 그 규칙이에요.
- **`AGENTS.md` 한 줄 (레포별, 로드 비용 0):** [code-map-bench/integrations/AGENTS.code-map.md](https://github.com/annyeong844/code-map-bench/blob/main/integrations/AGENTS.code-map.md) 참고.

둘 다 결국: *"기지 심볼은 code-map `read`로 읽어라(독립 ref는 한 콜에 batch); grep은 발견에만
쓰고 이중 fetch 금지."* MCP 서버도 시작 시 이를 스스로 광고하지만(무설정 baseline↑), *신뢰성*은
plugin/skill/규칙 지시가 줍니다.

**참조(선택, 타입-인지): `code-oracle`도 wire.** *호출자/정의/구현*은 스킬이 형제 `code-oracle`
(tsgo=TS/JS, ty=Python, checker-grade)로 escalate해요. 코어를 zero-dep로 두려고 분리된 별도 MCP라,
스킬이 닿을 곳에 배선하세요:

```bash
codex  mcp add code-oracle -- node /abs/path/to/map/code-oracle/server.ts
claude mcp add code-oracle --scope user -- node /abs/path/to/map/code-oracle/server.ts
```

tsgo 세션을 1회 워밍(~수초~20s, 레포 크기별)하니 스킬은 값어치 있을 때만(큰 레포·충돌 이름) 호출해요.
**크로스플랫폼:** code-oracle가 `/mnt/c/…` ↔ `C:\…` 경로를 정규화해서 **서버 하나가 Windows IDE와
WSL 에이전트(interop)를 동시에** 서빙해요 — 즉 빠른 **win32** 빌드가 WSL 클라이언트까지 담당해
`/mnt/c` drvfs 페널티를 피함(같은 레포 ~38s → ~4s).

</details>

<details>
<summary><b>📊 직접 벤치마크</b></summary>

```bash
git clone https://github.com/annyeong844/code-map-bench && cd code-map-bench
codex login --device-auth
node harnesses/bench-codex-headless.mjs --run --passes 30 --auth chatgpt --strategies native,map-batch
```

하네스([code-map-bench](https://github.com/annyeong844/code-map-bench))는 다양한 태스크셋에 pass@30을 돌리고, `codex exec --json`의
사용량을 캡처하며, **경로를 채점**(native 행은 MCP를 건드리면 실패; map-batch 행은
`read({ refs: [...] })`를 완료 못 하면 실패). raw, `adjusted = input − cached`, 캐시-인지
`effective = uncached + cached×weight`를 보고해 실제 프롬프트 캐시 하에서의 이득을 봅니다.
시나리오별 정직한 결론:

| 시나리오 | code-map vs grep | 언제 |
|---|---|---|
| known-cross-file | **토큰 −25%, 시간 −44%** | 파일에 흩어진 기지 심볼 읽기 — grep 완전 대체 |
| file-wide / known-single | 토큰 −15~21%, 시간 −28~35% | 기지 심볼, grep 대체 |
| discovery-first | 토큰 ↓ but **시간 ↑** | 먼저 grep으로 찾아야 → code-map은 보완만 |
| multi-symbol batch | ~동률 | native가 거기선 이미 batch |

*어디서나* 토큰을 줄이는 게 **아니에요** — 에이전트가 ref를 이미 알고 code-map이 검색을
*대체*(보완 아님)할 수 있을 때 가장 강합니다.

</details>

<details>
<summary><b>🏛️ 아키텍처 + <code>code-oracle</code> sibling</b></summary>

```
src/
  core/    types · files · extract-symbols (oxc) · fan-in · build-index · locate · read · store
  py/      extract.py   (Python: stdlib ast →같은 per-file 기본형)
  cli/     main.ts      (index / read / stats)
  mcp/     server.ts    (유일한 `read` 도구, 자동 리로드)
test/      extract · exact-slice · methods · relocation · anchor-lost · incremental · fan-in
           · snippet-aim · batch · path-traversal 거부 · Python
```

```bash
node --test "test/*.test.ts"
```

**`code-oracle/` — 선택적이고 분리된, 더 무거운 sibling.** `grep`과 경량 인덱스는
`obj.method()` 디스패치를 resolve 못 해요 — 그건 타입이 필요. code-oracle은 *누가 호출하나 /
무엇이 구현하나 / 어디 정의됐나*를 타입-체커 등급으로 답하는 **별도 MCP** (warm LSP 세션 —
TS/JS는 **tsgo**, Python은 **ty**). 의도적으로 분리: 무거운 preview 의존성, 수 초의 워밍업,
stateful — code-map의 1-dep 가벼움과 정반대. 정직한 범위(측정): tsgo는 단단; **ty(0.0.50)는
`definition`을 cross-file로 정확히 풀지만 `references`는 intra-file only** — 그래서 Python
`callers`는 intra-file 하한선(`incomplete: true` 플래그). 완전한 Python callers는 `grep`
(100% recall)을 쓰세요; 더 무거운 Python references 백엔드는 *일부러 안 추가.* 진짜 동적 디스패치
(토큰-only DI, `Proxy`, `obj[k]()`)는 어떤 체커에도 안 보여요. 자체 `package.json` + 테스트
(`cd code-oracle && npm test`).

</details>

<details>
<summary><b>🔧 메인테이너 / 퍼블리싱</b></summary>

```bash
npm test                 # 24 tests
npm run typecheck        # tsc --noEmit, strict (에러 0; src/는 any-free)
npm run lint             # npx oxlint (devDep 없음)
npm run check:package    # dry-run 패키지 파일목록 안전 검사
npm publish --access public   # prepublishOnly로 check:package 실행
```

`check:package`는 dry-run 파일 목록을 검사해 로컬 env/config 경로(`.env`, `.codex`,
`auth.json`, `config.toml`, …)나 토큰성 값이 실리면 *실패*시킵니다.

</details>
