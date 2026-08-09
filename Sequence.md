# Sequence — 이 플러그인이 동작하는 순서

`opencode.jsonc` 한 줄에서 시작해 툴이 호출되기까지의 전 과정. 파일:줄 표기는
이 레포 기준.

```
설치 ──▶ 로드 ──▶ 훅 병합 ──▶ 에이전트 등록 ──▶ 에이전트 선택 ──▶ 툴 호출
 (1)     (2)       (3)          (4)            (5)           (6)
```

---

## 1. opencode.jsonc 인지 → 설치

- 사용자가 쓰는 설정은 **한 줄**뿐이다.

  ```jsonc
  { "plugin": ["github:nedleeds/opencode"] }
  ```

- opencode는 **부팅할 때마다** 이 git specifier를 다시 해석한다.
  - 즉 레포에 push하면 사용자는 아무것도 안 해도 다음 실행에 반영된다.
  - 반대로 **깨진 커밋도 즉시 전파**된다. 고정이 필요하면 `#v0.1.0` 처럼 태그를 붙인다.
- 캐시 위치: `~/.cache/opencode/packages/github:nedleeds/opencode/`
  - 꼬였을 때는 이 디렉토리를 지우면 재설치된다.

```
opencode 부팅
   │
   ├─ opencode.jsonc 읽기 ──▶ "plugin": ["github:nedleeds/opencode"]
   │
   ├─ git specifier 재해석 (부팅마다)
   │     └─ ~/.cache/opencode/packages/... 에 clone
   │           └─ install (--ignore-scripts)
   │
   └─ package.json "main" ──▶ index.js          package.json:6
```

- 설치가 성립하기 위한 제약 두 가지 (둘 다 지키지 않으면 **조용히** 실패한다)
  - **빌드 단계 없음** — `ignoreScripts`라 `prepare`/`build`가 안 돈다. 전부 그대로 실행되는 ESM이어야 한다.
  - **의존성 최소** — 트리가 크면 opencode 부팅 시간 안에 install이 못 끝나고 `node_modules`가 반쯤 쓰인 채 남는다. 그래서 `zod` 하나뿐이고, `@opencode-ai/plugin` 대신 `tool.js`(identity 함수 + zod 재수출)를 쓴다.

---

## 2. 로드 — 진입점은 루트 `index.js` 하나

- `package.json`의 `main`이 가리키는 **레포 루트 `index.js`가 유일한 진입점**이다.
- `plugins/hrbook/index.js`는 진입점이 아니라, 루트가 찾아서 불러오는 하위 모듈이다.

```
~/Src/opencode/
├── index.js              진입점. discovery + 훅 병합만 한다
├── tool.js               @opencode-ai/plugin 대체 (identity + zod)
├── plugins/hrbook/
│   ├── index.js          툴 3개 정의 + HRBook 에이전트 등록  (opencode 의존 O)
│   ├── agent.md          에이전트 시스템 프롬프트
│   ├── lib.js            캐시·검색·랭킹·동기화              (opencode 의존 X)
│   └── cli.js            hrbook-sync
└── skills/               코드가 아니라 디렉토리로 등록
```

- `lib.js`에 opencode 의존이 **0**인 것이 핵심. 검색·랭킹 로직을 opencode 없이 단독 테스트할 수 있다.

---

## 3. 훅 병합

- opencode는 "모듈이 export하는 함수 = 플러그인"으로 보고 `(input, options)`로 호출한다.

```
index.js  NedleedsOpencode(input, options)              index.js:61
   │
   ├─ discover()                                        index.js:21
   │     └─ plugins/ 디렉토리 스캔 → ["hrbook"]
   │        (하드코딩된 목록 없음 → 새 플러그인은 폴더만 추가)
   │
   ├─ import plugins/hrbook/index.js
   │     └─ HrBookPlugin()  →  { config, tool }         plugins/hrbook/index.js:49
   │
   ├─ + skills 등록용 config 훅 하나 더 push             index.js:81
   │
   └─ merge()                                           index.js:36
         ├─ tool   : 합집합
         └─ config : 체인 (앞의 것을 덮지 않고 순차 실행)
```

- `merge()`가 필요한 이유: `config` 훅이 **두 군데**(hrbook, skills 등록)에서 나온다. 단순 객체 병합이면 하나가 다른 하나를 덮어쓴다.
- 플러그인 하나가 로드에 실패해도 나머지는 살아남고, 실패는 stderr에 찍힌다(`index.js:74`). opencode 자체는 플러그인 로드 실패를 TUI 토스트 외에는 알려주지 않는다.

---

## 4. 에이전트 등록

- opencode가 병합된 `config(cfg)` 훅을 호출하는 시점에 에이전트가 생긴다.

```
opencode ──▶ config(cfg)
   │
   ├─ cfg.agent.HRBook = { description, mode, prompt, permission }
   │                                          plugins/hrbook/index.js:57
   ├─ cfg.agent.build  ← hrbook_* 전부 deny
   ├─ cfg.agent.plan   ← hrbook_* 전부 deny   plugins/hrbook/index.js:66
   │
   └─ cfg.skills.paths += <repo>/skills       index.js:85
```

- **키가 곧 에이전트 이름이다. `name` 필드를 쓰면 안 된다.**
  - 둘 다 있으면 목록/피커는 `name`을, 프롬프트 경로는 키를 본다.
  - 결과: 에이전트는 멀쩡히 보이는데 프롬프트를 보내면 `UnknownError` → *"Failed to send prompt / Unexpected server error"*. 로그에 원인이 안 남는다.
  - 대문자 이름을 원하면 **키를 대문자로** 쓴다.
- `prompt`는 `agent.md`를 **읽어서 인라인**한다(`plugins/hrbook/index.js:30`).
  - `{file:...}` 템플릿은 *사용자의* config 디렉토리 기준으로 풀리는데, 플러그인은 그 경로를 모른다.
- 툴 목록은 `tools`가 아니라 **`permission` 룰셋에서 파생**된다.
  - `tools` 축약형은 config 파싱 단계(= 플러그인 실행 **이전**)에 permission으로 접히므로, 플러그인에서 설정하면 아무도 안 읽는다.
  - `edit`은 `write`/`edit`/`patch`를 한꺼번에 덮는 permission이다.
- 사용자 설정이 항상 이긴다 — 기본값을 먼저 펼치고 사용자 값을 나중에 펼친다.

  ```jsonc
  { "agent": { "HRBook": { "permission": { "bash": "allow" } } } }
  ```

---

## 5. HRBook 에이전트 모드

```
Tab (TUI) 또는  opencode --agent HRBook
      │
      ▼
세션 생성   agent=HRBook
      │
      ▼
프롬프트 전송
   └─ SessionPrompt.createUserMessage
        └─ cfg.agent 의 "키"로 에이전트 조회   ← name 필드 금지 지점
             ├─ 시스템 프롬프트 ← agent.md
             └─ 노출 툴       ← permission 룰셋에서 계산
```

### 이 모드를 쓰는 이유

- **컨텍스트가 절반이다** — 세션 시작 시 약 **4,200 토큰**. 기본 `build` 세션의 절반 수준.
  - 툴이 3개뿐이고 `write`/`edit`/`bash`가 꺼져 있기 때문. 툴은 켜져 있는 것만으로 설명문이 **매 요청마다** 컨텍스트를 먹는다.
- **역할이 프롬프트로 고정된다** — `agent.md`가 "먼저 검색, 근거 없으면 답하지 말 것, URL은 툴 출력에서 복사"를 강제한다. 범용 에이전트에 매번 지시할 필요가 없다.
- **사고 위험이 줄어든다** — 답이 실제 로봇 제어기 조작에 쓰인다. 없는 메뉴 경로를 지어내면 현장 사고로 이어지므로, 근거 없는 답을 금지하는 규칙이 프롬프트에 박혀 있다.
- **코딩 세션이 오염되지 않는다** — `build`/`plan`에서는 `hrbook_*`가 꺼져 있어서 매뉴얼 툴 설명이 컨텍스트에 얹히지 않는다.
- **설치가 링크 한 줄이다** — 툴·프롬프트·에이전트가 한 덩어리로 배포된다. 사용자가 `opencode.jsonc`에 프롬프트를 붙여넣을 일이 없다.

---

## 6. Tool 콜링

- 호출 **순서를 강제하는 건 코드가 아니라 `agent.md`의 "절차" 섹션**이다. 모델이 그 지시를 따라 아래 순서로 움직인다.

```
사용자 질문
   │
   ▼
① hrbook_search(query, lang?, product?, book_id?, limit?)
   └─ searchWithAutoSync()                              lib.js:323
        │
        ├─ search()                                     lib.js:243
        │    bookinfos.json 로드
        │    → listCached()  캐시된 book/ver 목록
        │    → lang / product / book_id 필터
        │    → walkMarkdown  (.md 순회, book.md 제외)
        │    → 검색어를 "전부" 포함하는 페이지만 통과
        │    → score = 경로매치×10 + heading×5 + 라인×2 + 1
        │    → 정렬 → Hi6/Hi7 중복 페이지 병합 → 상위 N건
        │
        ├─ [결과 0건] 또는 [rankBooks 4점↑ 인데 미캐시]
        │    └─ syncBook()   tarball 1개 → .md만 보존    lib.js:414
        │         └─ search() 재실행
        │
        └─ 반환: heading + snippet + 뷰어 URL
   │
   ├─ 스니펫으로 충분 ──────────────▶ 답변 (추가 툴 호출 없음)
   │
   ▼
② hrbook_read(book_id, ver_id, path, maxBytes?)   정확한 절차·파라미터가 필요할 때만
   └─ readPage()                                        lib.js:361
        경로 탈출 차단 → ${변수} 치환 → 기본 12,000B 컷 → 뷰어 URL 동봉
   │
   ▼   ①이 계속 헛칠 때만
③ hrbook_catalog(filter, product?, lang?)
   └─ rankBooks()   전체 카탈로그에서 후보 매뉴얼 나열     lib.js:195
```

### 툴 설계의 특장점

- **카탈로그를 컨텍스트에 안 넣는다** — 어느 매뉴얼이 그 주제를 다루는지 고르는 일을 `rankBooks()`가 **코드로** 한다. 모델에게 맡기면 카탈로그 5.4k 토큰(원본 13.7k)을 매 요청마다 실어야 한다. 코드 매칭은 공짜고 결정적이다.
- **질의 시점에 네트워크가 없다** — 검색·읽기가 `~/.cache/hrbook` 위의 순수 파일시스템 연산이다(약 500페이지에 37–83 ms). 없는 매뉴얼만 최초 1회 받아온다.
- **자동 동기화** — 사전 준비 단계가 없다. 처음 묻는 매뉴얼은 그 질문에서 ~5초 들여 받아오고, 이후로는 로컬이다. 폐쇄망이면 `HRBOOK_AUTOSYNC=0`으로 즉시 실패시킨다.
- **매뉴얼을 통째로 붓지 않는다** — `hrbook_search`는 heading·스니펫·링크만 준다. 모델은 정말 필요한 1~2페이지만 `hrbook_read` 한다.
- **빈 결과가 다음 행동을 지시한다** — 검색 실패 시 "없음"만 돌려주지 않고, *키워드를 줄여 한 번만 재시도 → 그래도 없으면 `hrbook_catalog` → 그래도 없으면 답을 만들지 말 것*까지 문자열로 반환한다(`plugins/hrbook/index.js:101`). 빈 결과만 주면 모델이 학습된 지식으로 매뉴얼 내용을 지어낸다.
- **툴 설명은 한 줄** — 설명문이 매 요청 컨텍스트에 상주하기 때문.
- **인자 이름은 도메인 어휘 그대로** — `book_id`, `ver_id`는 `bookinfos.json`과 뷰어 URL에서 쓰는 이름이다. 짧게 지어낸 이름은 호출 실패 + 재시도 비용이 이름 길이 절약분보다 크다.

- 전형적인 비용: 질문 하나에 **모델 호출 3회, 약 $0.03**.

---

## 7. Skills

- 스킬은 **코드가 아니라 디렉토리**다. `skills/<이름>/SKILL.md` 하나가 최소 단위다.

```
opencode 부팅
   └─ config 훅                                    index.js:82
        └─ cfg.skills.paths 에 <repo>/skills 추가
              (중복 추가 방지, 사용자가 설정한 경로는 유지)
   │
   ▼
세션 진행 중
   └─ 모델이 SKILL.md 의 frontmatter `description` 을 보고
        필요하다고 판단할 때 해당 스킬을 로드
```

- **언제 동작하나** — 등록은 부팅 시 1회, 로드는 **모델이 필요하다고 판단한 시점**이다. 항상 컨텍스트에 있는 게 아니다.
- 그래서 `description`은 요약이 아니라 **발동 조건**으로 쓴다. (`Use when … . Covers … .`)
- 스킬 안의 상대 경로(`scripts/foo.py`)는 자기 디렉토리 기준으로 풀린다. 레포가 어디에 설치됐든 동작한다.
- 사용자 쪽 설정 변경이 필요 없다 — 이 레포에 폴더를 하나 추가하면 다음 실행에 모두에게 전달된다.
- **현재 상태**: `skills/`에는 아직 등록된 스킬이 없다. 배선만 되어 있고 폴더를 넣으면 바로 동작한다.

---

## 요약

| 단계 | 트리거 | 핵심 파일 |
|---|---|---|
| 설치 | opencode 부팅 시 git specifier 재해석 | `opencode.jsonc`, `package.json` |
| 로드 | `main` → 루트 진입점 | `index.js` |
| 병합 | 플러그인 discovery 후 훅 결합 | `index.js:21`, `index.js:36` |
| 에이전트 등록 | `config(cfg)` 훅 | `plugins/hrbook/index.js:50` |
| 에이전트 진입 | Tab / `--agent HRBook` | `agent.md` (시스템 프롬프트) |
| 툴 호출 | `agent.md` 절차를 모델이 수행 | `plugins/hrbook/index.js`, `lib.js` |
| 스킬 로드 | 모델이 `description` 보고 판단 | `skills/`, `index.js:82` |
