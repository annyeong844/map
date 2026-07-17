# code-map

> 🇬🇧 **Read in English → [README.md](./README.md)** &nbsp;·&nbsp; 🇰🇷 한국어는 아래로.

> **AI 에이전트에게 필요한 코드 조각을 _추측 없이, 좌표로_ 정확히 건네줍니다.**
> _좌표만 정밀하게. 의미는 LLM이 raw를 보고 매번 새로 판정한다._

![Node](https://img.shields.io/badge/node-%E2%89%A523.6-green)
![langs](https://img.shields.io/badge/TS%2FJS-%2B%20Python-blue)
![deps](<https://img.shields.io/badge/runtime%20deps-1%20(oxc--parser)-brightgreen>)
![tool](https://img.shields.io/badge/tools-just%20%60read%60-ff69b4)
![release](https://img.shields.io/badge/release-0.9.0--rc.1-orange)

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

## 무엇을 얻나요 — 약속이 아니라 _측정값_

|                           |                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🎯 **조용히 틀리지 않음** | 대량 편집 후 재인덱싱 없이도 `read`는 시그니처 줄로 재앵커링: **조용히-틀린 바이트 0개** (순진한 "줄번호" 캐시는 ~100% 틀림). 맞는 코드를 주거나 _못 준다고 말할 뿐_, 절대 엉뚱한 바이트를 안 줍니다.                                                                                                                                          |
| ⚡ **토큰·단계 절감**     | 직접 기지-ref 실험(**GPT-5.6 Sol, pass@30, 180태스크, 실제 `rg` 강제 기준선**): **effective 입력 −22.4%, raw 입력 −26.3%, 시간 −14.7%, 호출 −67.9%**, 의미 정답률 동률. 더 최신 **다단 워크플로 paired n=10 파일럿**은 240개 채점 단계에서 **effective −31.8% / raw −40.4%, 시간 −14.7%, 호출 −74.6%**였고, pass@30 확인은 아직 진행 전입니다. |
| 🧭 **라우팅이 레버**      | 에이전트는 스스로 `read`를 잘 안 씀(~17%). 동봉 **plugin/skill**이 그걸 시킴: discovery를 *손해*에서 **−31%**로 뒤집고(이중호출 제거), 들쭉날쭉한 사용(한 시나리오 **+61%** 손해)을 안정적 승리로(**30/30 pass**).                                                                                                                             |
| 🧩 **가볍고 drop-in**     | Node + 설치 후 런타임 의존성 **1개**(`oxc-parser`), 수동 빌드 단계 없음. TS/JS **그리고** Python. MCP 서버 + 한 줄 skill — Claude·Codex·grok·Antigravity에 설치.                                                                                                                                                                               |

> **경계에 대해 정직하게** (이 레포의 핵심): code-map은 *검색*에서 `grep`을 못 이깁니다 —
> 동급이라 grep은 그냥 쓰세요. 그리고 _어디서나_ 토큰을 줄이는 마법도 아닙니다 — 기지 ref
> 읽기에선 **라우팅과 함께** 크게 이득이지만 모델·과제에 따라 다릅니다(이전 Sonnet/Opus
> 단발 과제는 ~0/손해, GPT-5.6 Sol known-single은 effective −20%). 순수 discovery에선
> skill이 라우팅하지 않으면 _손해_. 모든 수치·철회·모델/지표 주의·1-커맨드 검증기는
> **[code-map-bench](https://github.com/annyeong844/code-map-bench)** 에 있어요.

**한 줄 요약 — grep은 찾고, `read`는 읽는다.**

> **릴리스 상태:** `0.9.0-rc.1`은 공개 릴리스 후보입니다. 코어는 실제 프로젝트에서 쓸
> 준비가 됐고, RC 표시는 1.0 계약을 얼리기 전에 설치 피드백을 마지막으로 받기 위한 거예요.

### 패키지 호환성

이 RC는 의도적으로 `exports` 맵을 두지 않습니다. 따라서 `dist/` 아래에 출력되는 모든 모듈과
named export는 deep import를 포함해 패키지 호환 표면입니다. 저장소 내부 분석에서 소비자를
찾지 못했다는 이유만으로 제거하거나 숨기지 않습니다. 이 표면을 제한하려면 마이그레이션
안내를 포함한 명시적 버전 단위 breaking release가 필요합니다.

---

## 빠른 시작

```bash
# 1. 릴리스 후보 설치 (첫 npm 릴리스 뒤에는 `next` 채널)
npm install -g @annyeong844/code-map@next
# 그 전에는(검증된 프리빌트 JS 사용): npm install -g github:annyeong844/map

# 2. 라우팅 plugin/rules와 MCP를 함께 배선 (--apply 없이는 dry-run)
map setup codex --apply
# 다른 호스트: map setup claude --apply  |  map setup gemini --apply

# 3. 선택적 사전 워밍업 (첫 MCP read가 자동 생성할 수도 있음)
cd /path/to/your-repo && map index --root .  # ./.map-index.json 생성
```

끝 — 이제 에이전트엔 도구 하나 `read`가 생겼어요. Codex에서 **−19% / −67%** 효율 이득까지
보려면 _언제_ code-map을 쓸지 한 줄로 알려줘야 합니다(아래 _실전 배선_ 참고). 레포 안에서
시작한 MCP는 인덱스를 자동 탐지하고, 전역 MCP 하나는 각 `read`의 `root`로 여러 레포를
전환합니다(동봉 스킬이 전달). 없거나 호환되지 않는 인덱스는 첫 읽기에서 지연 생성합니다.
소스 변경 이벤트는 O(1) dirty 세대만 올리고, 다음 읽기가 공유된 O(파일 수) stat 스캔을 한 번
수행해 변경량이 `ceil(sqrt(프로젝트 파일 수))`에 닿으면 증분 재빌드합니다. 새 심볼을 요청했는데
못 찾으면 작은 변경도 재빌드하고 한 번 재시도해요. 백그라운드 파서나 polling 자식은 없어
오르펀으로 남지 않습니다. MCP `initialize`에서는 인덱스를 읽거나 lookup을 준비하지 않으므로
레포 크기가 handshake를 막지 않습니다. 그 비용은 첫 `read`가 맡고, stdout backpressure가
대기 응답 바이트를 제한합니다. 끄려면 `CODE_MAP_AUTO_INDEX=off`, 호출 시 fallback 검사 간격은
`CODE_MAP_AUTO_INDEX_POLL_MS`(기본 2000ms)로 바꿀 수 있어요.

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
- "auth는 어디서 처리되지?" 같은 개념 검색 — 그건 임베딩(여기선 _측정된_ 비-목표)

---

## 유일한 도구: `read`

```bash
map read "alias-map.ts#buildAliasMap"        # 경로-스코프 이름 → 정확한 슬라이스
map read "server.py#Outer/Inner/run"          # 중첩 심볼의 정확한 어휘 경로
map read buildAliasMap                       # 맨이름 (모호하면 에러)
map read withRetry --snippet "req.copy()"    # 심볼 *안의* char 범위
map read --refs "getModel,createMessage,withRetry"   # batch: 여러 심볼, 한 콜
map stats                                    # 인덱스 개요
```

기계 출력은 `--json`. **검색은 직접 `grep`으로** — 찾은 `file:line`이나 심볼 이름을 `read`에
넘기세요. MCP 도구로도 같은 `read`(절대 레포 경로 `root`, 단일 `ref`, batch용 `refs` 배열,
선택적 `snippet`). Windows 경로와 `/mnt/<드라이브>/...` WSL 표기를 서로 바꿔 써도 됩니다.
Windows에서 실행 중인 MCP가 네이티브 WSL ext4 레포를 읽을 때는 레포의
`\\wsl.localhost\<distro>\...` UNC 경로를 `root`로 주세요. WSL에서 실행 중인 서버도
현재 배포판과 일치하는 UNC 표기를 받아들입니다. `ref`는 계속 레포 상대 `path#symbol`로
주세요.
실제 파일을 지정한 `path#symbol`은 strict 계약입니다. 정확한 심볼이나 어휘 경로가 없으면
다른 fuzzy 이름을 조용히 승격하지 않고 후보/실패를 반환합니다. 클래스 메서드와 Python 중첩
선언은 `path#Outer/Inner/method`도 받으며, 기존 leaf ID도 계속 유효합니다.
AST로 증명된 Python 모듈 binding—일반/주석 assignment와 PEP 695 `type` alias—도 인덱싱하지만,
함수 local과 class field는 심볼 표면에 넣지 않습니다.
exact slice는 UTF-8 소스(UTF-8 BOM 포함)를 요구하며, 다른 인코딩은 잘못 디코딩하거나 missing으로
숨기지 않고 degraded로 표시합니다.
Python 슬라이스는 앞의 데코레이터(`@dataclass`, `@property` 등)까지 포함합니다. 저장 중인
Python 파일이 잠시 문법 오류 상태가 되면 증명된 이전 심볼을 조용히 삭제하지 않고 stale로
보존하며, 다음 유효한 편집 전까지 CLI와 MCP 진단에 degraded 파일로 표시합니다.
UNC 레포에서는 Windows 서버가 해당 WSL 배포판의 네이티브 Git에 gitignore-aware 파일
목록을 요청합니다. 그래서 Windows와 Linux가 같은 파일 집합을 보고 공유 인덱스를 번갈아
재빌드하지 않습니다.

일반적인 LLM 읽기에는 `responseFormat: "compact"`를 더하세요. 안전 상태, 소스 좌표,
주의사항, raw 소스는 그대로 두고 반복 JSON 키와 파일 메타데이터만 걷어냅니다. 기계 소비자를
위해 기본값은 계속 `json`입니다. 대표적인 함수 2개 읽기에서는 2,453바이트가 2,144바이트로
줄었습니다(12.6%). 본문 코드가 대부분이므로 포장 비용은 줄지만 토큰이 한 자릿수 배율로
사라지는 마법은 아닙니다.

편집 뒤 이전 MCP 작업 세트를 갱신할 때는 같은 `refs`에 `changedOnly: true`를 보내세요.
장기 실행 서버는 실제로 전에 반환한 슬라이스와 비교하므로, 중간에 자동 재인덱스가 끼어도
편집된 심볼을 거짓 `unchanged`로 숨기지 않습니다. 세션 기준선이 없는 ref는 보수적으로 현재
슬라이스를 반환합니다. 일회성 `map changed` CLI는 이전 세션이 없으므로 인덱스 기준입니다.

인덱스 바이트는 자동 리로드되지만 MCP 서버 코드와 클라이언트 설정은 hot-reload되지 않습니다.
세션이 이전 명령/파일을 실행 중인지 의심되면 `diagnostics: true`를 보내세요. 응답에 실제
instance id, pid, 시작 시각, entrypoint, 서버 파일, 시작/현재 source identity와
`restartRequired`가 나옵니다. 이 값이 `true`이거나 보고된 entrypoint가 설정과 다르면 그 결과를
근거로 쓰기 전에 새 MCP 세션을 시작해야 합니다.

---

<details>
<summary><b>🧪 정직한 성적표 — 남긴 것, 데이터가 자르게 한 것</b></summary>

code-map은 넓게 시작했고(locate, grep, graph, hotspots, 시맨틱 검색) **`grep` + 강한
에이전트와 정직하게 벤치마크**(Sonnet/Opus, 헤드리스, 실제 레포 — `cline`, `django`,
`requests`)했어요. 측정이 대부분을 먹었고, 표면을 거기에 맞춰 잘랐습니다. _베이스라인을
이긴 것만 남긴다_ — 그게 핵심이에요.

| 능력                                            | `grep` + 강한 에이전트 대비 측정                                                                                                                                                                                                                                          | 판정              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **드리프트-안전 READ** (`read`)                 | 대량 churn 후 재인덱싱 없이: **조용히-틀린 바이트 0**, 94.5% 복구 vs 순진한 줄-캐시 **100% silent**. 재현됨.                                                                                                                                                              | **유지**          |
| **드리프트-안전 EDIT** (`read --snippet`)       | 인용 스니펫 → churn 후의 _현재_ char 범위: **조용한 오타게팅 0** vs 순진한 방식 **100%**.                                                                                                                                                                                 | **유지**          |
| **`refs` batch 토큰**                           | pass@30, 150 태스크, 실 plugin(codex): **effective 토큰 −18.6%, 셸 명령 −67%, pass@30 동률, MCP fail 0.** grep을 완전 대체할 때 최대(known-cross-file 토큰 −25% / 시간 −44%); 보완만 할 땐 동률/느림(discovery, multi-symbol batch). **Opus에선 손해**(native가 이미 린). | **유지**          |
| **GPT-5.6 Sol 기지 ref**                        | pass@30, 실제 `rg` 강제 기준선과 180태스크: **effective 입력 −22.4% / raw −26.3%, 시간 −14.7%, 호출 −67.9%, 검색 페이로드 −58.4%**; 의미 답변은 전략별 90/90 동률. known-single만도 **effective −20.0%**.                                                                 | **유지**          |
| **GPT-5.6 Sol 다단 워크플로**                   | paired **n=10 파일럿**, 4단계 워크플로 3개 / 채점 240단계: **effective −31.8% / raw −40.4%, 시간 −14.7%, 호출 −74.6%, 페이로드 −25.5%**; 의미 답변은 전략별 120/120 동률. **아직 pass@30 아님.**                                                                          | **유망한 파일럿** |
| **Read — turns**                                | 에이전트 _턴_ −25–30% (K=30, 양 모델, CI가 0에서 떨어짐).                                                                                                                                                                                                                 | **유지**          |
| **Caller 정밀도** (`code-oracle`, 별도 sibling) | blast-radius에서 **읽을 파일 31% 감소**(흔한 이름 40–75%); 타입 체커가 *어느 클래스 메서드*인지 가림. LSP 워밍업 비용.                                                                                                                                                    | **유지(sibling)** |
| **단발-read 토큰**                              | 초기 포괄적 "−16–35%"는 K=5 노이즈라 해당 Sonnet/Opus 과제(~0/손해)에 대해 올바르게 철회. 그러나 일반적 무절감을 뜻하진 않음: GPT-5.6 Sol known-single은 **effective −20.0% / raw −24.1%**.                                                                               | **범위 수정**     |
| **검색 / `locate`**                             | `grep`과 **동급**(100% recall).                                                                                                                                                                                                                                           | 제거              |
| **시맨틱 임베딩**                               | **더 나쁨** — 3가지로 독립 기각, grep 에이전트를 _오히려 악화_.                                                                                                                                                                                                           | 안 만듦           |
| **경량 call-graph**                             | recall에서 **grep에 패배**(dispatch/타입에 눈멈).                                                                                                                                                                                                                         | 제거              |

전체 수치, round-trip 법칙, 채택 사다리, 모든 철회는
**[code-map-bench](https://github.com/annyeong844/code-map-bench)** 에 —
[RESULTS.md](https://github.com/annyeong844/code-map-bench/blob/main/RESULTS.md)(drift/edit/oracle)

- [EFFICIENCY-CODEX.md](https://github.com/annyeong844/code-map-bench/blob/main/EFFICIENCY-CODEX.md)
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
심볼을 다시 찾고 결과를 **플래그**해서 경계를 확인하게 합니다 — _조용히 신뢰하는 게 없음._
이게 맹목적 `Read(file, lineRange)` 대비 우위예요: stale 줄범위는 엉뚱한 바이트를 주지만,
`read`는 재앵커링하거나 _못 한다고 말함._ `--snippet`은 심볼 _안의_ char 범위를 주고,
이웃 심볼로 절대 새지 않아요.

</details>

<details>
<summary><b>🧱 왜 의미가 아니라 좌표인가</b></summary>

_의미_(요약)를 저장하는 지도는 그게 stale 되는 걸 막아야 해요 — 생산자, 검증자, 재생성.
해석을 저장 안 하면 그 기계장치가 사라지고, 남는 건 기계가 검증 가능한 것뿐: **좌표 인덱스**
(`path`/`line`/`charStart–charEnd`) + 그 좌표가 여전히 유효한지 말하는 **파일당 토큰 하나.**
유일한 질문 — _"이 좌표가 맞나?"_ — 엔 답이 있어요. _"이 설명이 맞나?"_ 는 _묻지 않습니다._
LLM이 raw 바이트를 매 콜마다 새로 읽고 판정해요.

**좌표는 어디서 오나:** code-map은 소스 트리를 _직접_ 파싱해요(외부 그래프 없음). git-추적
파일(`git ls-files`, `.gitignore` 존중) → **TS/JS는 `oxc-parser`**, **Python은 패키지에 포함된
네이티브 Ruff 파서**(정확히 동치인 stdlib-`ast` fallback 포함) — 둘 다 같은 per-file 기본형
(심볼 좌표 + `searchText` 드리프트-앵커 + 콘텐츠 토큰)을
냅니다. `fanIn`(cross-file 참조 수)은 맨이름이 둘 이상으로 resolve될 때 *타이브레이크*에만 씀.
네이티브 추출기는 한 프로세스 안에서 병렬 파싱하고, 미지원/소스 전용 설치는 메모리 상황에 맞춘
단기 Python worker로 fallback합니다. 빌드 뒤 남는 상주 파서 프로세스는 없고, 정식 패키지는
Python 런타임도 필요 없습니다. 정직한 범위: namespace / `export *` / alias 임포트는 미귀속.

</details>

<details>
<summary><b>🔌 실전 배선 (설치 옵션 + 효율 이득)</b></summary>

**요구사항:** Node ≥ 23.6, 설치 후 npm 런타임 의존성 1개(`oxc-parser`); 파일 walk엔 `ripgrep`이
있으면 사용. 정식 tarball은 설치 중 빌드하지 않고, 임시 GitHub 소스 경로도 CI에서 소스와 대조한
동일한 `dist`를 사용합니다. 지원되는 정식 패키지에는 네이티브 Python
추출기가 포함됩니다. 릴리스 CI가 Windows x64, Linux x64/arm64(정적 musl), macOS x64/arm64
프리빌트를 각각 빌드·실행 검증하며 npm 설치 중에는 Rust를 컴파일하지 않습니다. 미지원/소스 전용
설치에서는 Python 3을 Unix의 `python3`/`python`,
Windows의 `py -3`/`python3`/`python` 순으로 탐지합니다. `CODE_MAP_PY_BACKEND=stdlib`은
fallback을 강제하고, `CODE_MAP_PYTHON`은 그 인터프리터를, `CODE_MAP_PY_NATIVE`는 별도 네이티브
실행 파일을 지정합니다. 소스 기여자는 `npm run build:native`로 현재 OS 바이너리를 준비할 수 있어요.
네이티브 WSL 설치라면 WSL _안에서_ `node --version`을 확인하세요. Windows Node가 최신이어도
낡은 WSL Node는 그대로이고, 실제 실행 환경의 Node가 23.6 이상이어야 합니다.

**설치:** `npm install -g @annyeong844/code-map@next`(RC 채널) ·
`npm install -g github:annyeong844/map`(npm 릴리스 전) · 또는 clone + `npm install && npm link`.
모두 `map`과 `map-mcp`를 제공.
`github:` 경로는 소스 전용이지만 JavaScript는 install lifecycle 없이 프리빌트로 제공하고,
Python은 네이티브 추출기를 별도로 준비하지 않으면 아래의 stdlib fallback을 사용합니다.

`oxc-parser`에는 OS별 native binding이 있으므로 Windows와 WSL이 하나의 `node_modules`를
공유하면 안 됩니다. 특히 WSL의 `map-mcp`를 `/mnt/c` 아래 Windows checkout에 `npm link`하면
Linux binding을 찾다가 MCP `initialize` 전에 종료됩니다. 실행 주체를 하나만 고르세요:

```bash
# WSL 네이티브 실행 (레포가 WSL ext4에 있을 때 권장)
npm install -g @annyeong844/code-map@next
codex mcp add code-map -- "$(command -v map-mcp)"
# 해석된 package 경로가 /mnt/c가 아니라 WSL 파일시스템 안에 있어야 합니다.

# WSL interop으로 Windows 설치를 실행 (/mnt/c 레포에 권장)
codex mcp add code-map -- /mnt/c/path/to/node.exe \
  'C:\path\to\node_modules\@annyeong844\code-map\dist\mcp\server.js'
```

두 실행 주체가 같은 인덱스를 동시에 만지게 하지 마세요. Windows와 Linux의 파일 identity
메타데이터가 다릅니다. `/mnt/c` 레포에서는 Windows 실행이 drvfs stat 비용도 피합니다. 이곳의
42파일 smoke에서는 새 프로세스의 exact read가 약 27초에서 0.2초로 줄었습니다.

`map setup codex --apply`는 native `map-mcp`, 위 Windows-package interop, 그리고
`cmd.exe /d /c map-mcp` 래퍼를 인식합니다. 실제 `initialize` 교환을 사전 검사하고 그 밖의
command/args는 고칩니다. 잘못된 cross-OS 실행기는 다음 Codex 재시작까지 숨어 있지 않고
native-binding stderr와 함께 setup 단계에서 바로 실패합니다.

그다음 `map setup codex|claude|gemini`를 쓰세요. 기본은 검토 가능한 dry-run이고 `--apply`를
붙일 때만 사용자 설정을 바꿉니다. 측정상 둘 다 필요한 라우팅 규칙/plugin과 MCP를 함께 설치해요.

**MCP 설정** — 전역 서버 하나가 호출별로 레포를 전환:

```jsonc
{ "root": "/absolute/path/to/repo", "refs": ["path#a", "path#b"] }
```

여러 레포에는 `root`가 권장 경로입니다. 도구 인자를 줄 수 없는 단일 레포 클라이언트에서만
`MAP_INDEX`를 고정하세요:

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

- **Codex 동봉 plugin/skill (Codex에 권장):** 이 레포가
  `plugins/code-map/skills/code-map-retrieval/`에 Codex용 라우팅 skill을,
  `.codex-plugin/plugin.json`과 `.agents/plugins/marketplace.json`에 매니페스트를 동봉해요.
  ```bash
  map setup codex --apply
  map setup claude --apply
  grok plugin install annyeong844/map          # Grok (또는 로컬 경로)
  ```
  **discovery 이중호출 가드** 포함 — 발견은 grep으로 하고 _멈춰라_, 위에 `read` 얹지 마라 —
  3-arm 벤치에서 discovery를 손해→승리로 뒤집은 그 규칙이에요.
- **`AGENTS.md` 한 줄 (레포별, 로드 비용 0):** [code-map-bench/integrations/AGENTS.code-map.md](https://github.com/annyeong844/code-map-bench/blob/main/integrations/AGENTS.code-map.md) 참고.
- **Antigravity / Gemini:** `map setup gemini --apply`가 동봉 `GEMINI.md` 라우팅 블록과
  `~/.gemini/config/mcp_config.json`의 MCP 항목을 기존 설정을 보존하며 병합합니다.

둘 다 결국: _"기지 심볼은 code-map `read`로 읽어라(독립 ref는 한 콜에 batch); grep은 발견에만
쓰고 이중 fetch 금지."_ MCP 서버도 시작 시 이를 스스로 광고하지만(무설정 baseline↑), *신뢰성*은
plugin/skill/규칙 지시가 줍니다.

**참조(선택, 타입-인지): `code-oracle`도 wire.** *호출자/정의/구현*은 스킬이 형제 `code-oracle`
(tsgo=TS/JS, ty=Python, checker-grade)로 escalate해요. 코어를 zero-dep로 두려고 분리된 별도 MCP라,
스킬이 닿을 곳에 배선하세요:

```bash
codex  mcp add code-oracle -- node /abs/path/to/map/code-oracle/server.ts
claude mcp add code-oracle --scope user -- node /abs/path/to/map/code-oracle/server.ts
```

**RC 배포 정책:** `code-oracle`은 코어 npm tarball에 들어가지 않고 아직 별도 퍼블리시하지도
않습니다. 이 레포를 clone하고 `code-oracle/`에서 `npm ci`한 뒤 위 checkout 경로로 배선하세요.
코어 code-map은 그대로 독립 설치 가능하고 런타임 의존성 하나만 유지합니다.

GA `typescript@7.0.2`는 빌드 컴파일러 `tsc`만 노출하고, code-oracle가 LSP 서버로 쓰는
`tsgo` launcher는 아직 제공하지 않습니다. 그래서 code-oracle는 최신
`@typescript/native-preview` LSP 빌드를 정확히 핀합니다. 패키지 설치에서는 Node launcher와
그 자식을 함께 남기지 않고 플랫폼의 native `tsgo` 실행 파일을 직접 해석합니다. 명시적
`TSGO_BIN` launcher도 계속 지원합니다. 신뢰된 서버 설치 트리에서만 패키지를 해석하므로
workspace hoist/pnpm 배치를 지원하면서 조회 대상 workspace의 의존성은 실행하지 않습니다.

세션은 첫 checker 요청에서 지연 시작합니다(~수초~20s, 레포 크기별). 시작 비용을 미리 내는 편이
확실히 이득일 때만 `CODE_ORACLE_PREWARM=1`을 설정하세요. MCP 하나당 warm 세션은 기본 2개로
제한되고 10분 idle 후 회수됩니다(`CODE_ORACLE_MAX_SESSIONS`, `CODE_ORACLE_SESSION_IDLE_MS`로
조정). MCP stdin이 닫히면 모든 LSP 자식도 즉시 정리합니다.
같은 root의 동시 요청은 정확한 fingerprint scan 하나를 공유하고, 동일 checker 질의는 진행 중인
LSP 요청 하나를 함께 씁니다. 기본 fingerprint TTL=0에서는 완료된 전체 파일 맵을 보관하지 않고
즉시 놓아줍니다. 영속 answer cache는 project epoch당 snapshot을 한 번만 쓰고 같은 epoch의 답은
delta로 덧붙여, 누적 제곱 cache rewrite를 피합니다.
LSP 요청 timeout은 빈 결과가 아니라 checker 실패입니다. 고장 난 backend를 즉시 종료하고 다음
질의가 새 세션을 시작합니다. MCP/LSP JSON은 경로·캐시·checker 상태에 닿기 전에 신뢰하지 않는
입력으로 검증합니다.
성공한 모든 응답은 구조화된 `coverage`를 포함합니다. `implementations.results`는 checker가 본 전체
가능 후보를 그대로 보존하고, TS/JS에서는 직접적인 `new Class` / `useClass: Class` 소스 힌트로
각 후보를 `likely` 또는 `possible`로 표시합니다. 이 순위는 읽는 순서에만 쓰세요:
`implementationEvidence.runtimeObserved`는 언제나 `false`이고 어휘적 오탐·이름 충돌·dead code
가능성이 남습니다. `evidence: false`는 후보 집합을 바꾸지 않고 선택적 프로젝트 스캔만 생략합니다.
**크로스플랫폼:** code-oracle가 `/mnt/c/…` ↔ `C:\…` 경로를 정규화해서 **서버 하나가 Windows IDE와
WSL 에이전트(interop)를 동시에** 서빙해요 — 즉 빠른 **win32** 빌드가 WSL 클라이언트까지 담당해
`/mnt/c` drvfs 페널티를 피함(같은 레포 ~38s → ~4s). 네이티브 **Linux/WSL도 지원**합니다.
그 환경의 Node/npm으로 `code-oracle/`을 설치하면 `native-preview-linux-<arch>`를 고르고,
다른 OS가 남긴 wrapper뿐인 설치는 요청당 40초씩 두 번 기다리지 않고 즉시 거부합니다.

</details>

<details>
<summary><b>📊 직접 벤치마크</b></summary>

레포 내부 복잡도 마이크로벤치는 full/no-op 인덱싱, cold/warm locate, line-only 64심볼 읽기,
순수 wildcard와 named/wildcard 혼합 10,000파일 barrel 체인을 함께 잽니다:

```bash
npm run bench
```

단계별 실제 저장소에서 원본을 쓰지 않고 검증하려면(cold/no-op 시간, exact 읽기, 메모리,
워커 정상 종료, 실행 전후 소스 지문):

```bash
npm run corpus:lab
node --expose-gc scripts/corpus-lab.mjs --profile stress --out .audit/corpus/next.json
```

프로파일·안전 보장·정직한 한계는 [코퍼스 랩 프로토콜](./docs/corpus-lab.md)에 적었습니다.

```bash
git clone https://github.com/annyeong844/code-map-bench && cd code-map-bench
codex login --device-auth
node harnesses/bench-codex-headless.mjs --run --passes 30 --auth chatgpt --repo ../map --strategies native,map-batch
# 중첩 셸이 제한되면 실제 rg 기준선을 강제:
node harnesses/bench-codex-headless.mjs --run --passes 30 --repo ../map --strategies grep-mcp,map-batch --model gpt-5.6-sol
```

하네스([code-map-bench](https://github.com/annyeong844/code-map-bench))는 다양한 태스크셋에 pass@30을 돌리고, `codex exec --json`의
사용량을 캡처하며, **경로를 채점**(native 행은 MCP를 건드리면 실패; map-batch 행은
`read({ refs: [...] })`를 완료 못 하면 실패). raw, `adjusted = input − cached`, 캐시-인지
`effective = uncached + cached×weight`를 보고해 실제 프롬프트 캐시 하에서의 이득을 봅니다.
시나리오별 정직한 결론:

| 시나리오                 | code-map vs grep           | 언제                                          |
| ------------------------ | -------------------------- | --------------------------------------------- |
| known-cross-file         | **토큰 −25%, 시간 −44%**   | 파일에 흩어진 기지 심볼 읽기 — grep 완전 대체 |
| file-wide / known-single | 토큰 −15~21%, 시간 −28~35% | 기지 심볼, grep 대체                          |
| discovery-first          | 토큰 ↓ but **시간 ↑**      | 먼저 grep으로 찾아야 → code-map은 보완만      |
| multi-symbol batch       | ~동률                      | native가 거기선 이미 batch                    |

더 최신 GPT-5.6 Sol 실제-`rg` 강제 기지-ref 실험(3 시나리오 × 30)은 전체 **effective 입력
−22.4%, raw 입력 −26.3%, 시간 −14.7%**를 측정했습니다. known-single 셀도 **effective
−20.0%**로, 이전 문구가 "단발 read는 보편적으로 ~0"처럼 읽히던 부분을 바로잡습니다.
전체 보고서: [GPT-5.6 Sol pass@30](https://github.com/annyeong844/code-map-bench/blob/main/results/gpt56-sol-pass30.md).

연속 워크플로 후속 실험(탐색 → 추적 → 변경 영향 분석 → 도구 없는 종합)에서도 paired
10회 동안 절감이 유지됐습니다: **effective 입력 −31.8%, raw 입력 −40.4%, 시간
−14.7%, 호출 −74.6%**, 의미 정답은 전략별 120/120 동률입니다. 이는 명시적으로
**n=10 파일럿**이며 pass@30 결과가 아닙니다. 자세한 내용은
[다단 워크플로 보고서](https://github.com/annyeong844/code-map-bench/blob/main/results/gpt56-sol-workflow-pilot10.md)를 참고하세요.

_어디서나_ 토큰을 줄이는 게 **아니에요** — 에이전트가 ref를 이미 알고 code-map이 검색을
_대체_(보완 아님)할 수 있을 때 가장 강합니다.

</details>

<details>
<summary><b>🏛️ 아키텍처 + <code>code-oracle</code> sibling</b></summary>

```
src/
  core/    types · files · extract-symbols (oxc) · fan-in · index-drift · build-index · locate · read · store
  py/      extract.py   (이식 가능한 Python stdlib fallback)
  cli/     main.ts      (index / read / changed / stats / setup / version)
  mcp/     server.ts    (유일한 `read` 도구, 지연 자동 인덱싱 + 실제 프로세스 진단)
native/
  python-extractor/     (핀 고정 Ruff 파서 → 같은 per-file 기본형)
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
(100% recall)을 쓰세요; 더 무거운 Python references 백엔드는 _일부러 안 추가._ 진짜 동적 디스패치
(토큰-only DI, `Proxy`, `obj[k]()`)는 어떤 체커에도 안 보여요. 자체 `package.json` + 테스트
(`cd code-oracle && npm test`). 응답의 `coverage`가 이 경계를 기계가 읽을 수 있게 밝힙니다:
TypeScript callers는 checker-confirmed, implementations는 checker-visible 과대근사,
Python references는 intra-file 하한선입니다.

</details>

<details>
<summary><b>🔧 메인테이너 / 퍼블리싱</b></summary>

```bash
npm test                 # 49 tests
npm run typecheck        # tsc --noEmit, strict (에러 0; src/는 any-free)
npm run lint             # 핀한 oxlint
npm run release:check    # 전체 검사 + 새 tarball CLI/MCP smoke
```

`check:package`는 dry-run 파일 목록을 검사해 로컬 env/config 경로(`.env`, `.codex`,
`auth.json`, `config.toml`, …)나 토큰성 값이 실리면 *실패*시킵니다.
GitHub release는 npm Trusted Publishing(OIDC + provenance)으로 배포하고, prerelease는 `next`,
stable은 `latest` dist-tag로 갑니다.

첫 npm 퍼블리시만 1회 부트스트랩입니다. `0.9.0-rc.1`을 2FA로 수동 퍼블리시한 뒤 npm의
GitHub Trusted Publisher를 `annyeong844/map` · workflow `publish.yml` · environment `npm` ·
허용 액션 `npm publish`로 설정하고 GitHub environment를 보호하세요. 그다음 릴리스부터는
OIDC와 자동 provenance를 쓰며, Actions에 장기 npm token을 넣지 않습니다.

</details>
