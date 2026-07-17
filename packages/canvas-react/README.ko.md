# @langchain-canvas/react

LangChain 챗 앱을 위한 캔버스. 에이전트가 아티팩트(웹 페이지·스프레드시트·슬라이드·차트·문서)를 스트리밍하면 대화 옆에 실시간으로 뜨고 그 자리에서 편집됩니다. 사용자가 직접 손보고 실제 파일로 내보낼 수 있습니다.

ChatGPT Canvas나 Claude Artifacts 같은 경험을, **내 React 앱에 넣고 내 에이전트에 연결하는 패키지**로 제공합니다.

> [English README](./README.md)

```tsx
const { sendMessage, messages, canvas } = useCanvasStream({ endpoint: "/api/chat" });
// 사용자: "요금제 3개 비교 표 만들어줘"
// → <Canvas /> 에 진짜 스프레드시트가, 수식까지 계산되어 나타남
```

## 설치

```bash
npm i @langchain-canvas/react
```

Office 포맷 import/export는 선택적 peer 패키지를 씁니다 — 필요한 것만 설치하세요:

```bash
npm i exceljs docx pptxgenjs fast-formula-parser
```

미설치 시 해당 export만 "무엇을 설치하라"고 안내하고, 나머지는 정상 동작합니다.

## 마운트

두 가지만 있으면 됩니다: 에이전트 스트림을 받는 훅과, 그걸 렌더하는 패널. store를 공유하므로 둘 사이 배선이 없습니다.

```tsx
import { Canvas, useCanvasStream } from "@langchain-canvas/react";
import "@langchain-canvas/react/styles.css";

function App() {
  const { sendMessage, messages } = useCanvasStream({ endpoint: "/api/chat" });
  return <Canvas />; // sendMessage/messages는 당신의 챗 UI에서 렌더
}
```

- `useCanvasStream({ endpoint })` → `{ sendMessage, messages, canvas, isStreaming, editSelection }`
- `<Canvas />`는 `"use client"` 포함 → **Next.js App Router** 파일에 그대로 사용
- `/api/chat`는 와이어 프로토콜(`canvas.create` / `append` / `patch` / `replace`)로 SSE 스트리밍. 동봉 Python 패키지가 LangChain/LangGraph 에이전트에서 이 프레임을 내보내고, 같은 JSON을 보내는 어떤 백엔드든 동작.

셋업은 이게 전부입니다. 이후는 **각 기능 사용법** — 전부 사용자가 렌더된 아티팩트에서 직접 조작하는 것이고, 당신 쪽 추가 코드는 없습니다.

---

## 기능과 사용법

### 🌐 웹 페이지 (`html`) — 비주얼 페이지 빌더

HTML이 기본 substrate이고, 샌드박스 iframe에 렌더됩니다. 에이전트가 만든 어떤 HTML에도 편집이 동작합니다.

- **클릭 선택** — 호버 시 강조, 클릭 시 선택
- **드래그 이동** — 선택 요소를 드래그해 이동(CSS transform 사용 → 비파괴적, 레이아웃/반응형 유지)
- **정렬 스냅 가이드** — 이동 중 다른 요소의 가장자리·중심, 컨테이너 중앙에 스냅 + 빨간 가이드선 (Figma처럼)
- **리사이즈 핸들** — 모서리를 끌어 크기 조절. **이미지는 `%`로 리사이즈** → 화면에 따라 스케일(모바일에서 작게, 데스크톱에서 크게)
- **영역 선택(마퀴)** — 박스로 완전히 감싼 요소를 선택(예측 가능: 최외곽 항목, 여러 자식을 가진 래퍼는 자식들로 내려감)
- **그룹/해제** — 2개 이상 선택 후 Group → 공유 id 부여(래퍼 없음 → 레이아웃 안 깨짐)로 함께 이동. 멤버 클릭 시 그룹 선택 → Ungroup
- **텍스트 인라인 편집** — 텍스트 더블클릭 → 떠 있는 툴바로 **굵게 / 기울임 / 밑줄 / 링크**
- **스타일 인스펙터** — 색상·배경·폰트 크기/굵기·줄간격·자간·패딩·모서리·너비, 그리고 **배경 그라디언트·배경 이미지**(업로드 또는 URL)
- **이미지 교체** — 이미지 선택 → 파일 **Upload**(data URI로 임베드) 또는 **URL** 붙여넣기
- **블록 추가** — 제목·텍스트·버튼·이미지·구분선 삽입
- **섹션 템플릿** — 완성된 **Hero / Features / CTA** 섹션 삽입(자체 스타일·반응형)
- **구조 편집** — 선택 요소 복제·삭제·순서 변경(위/아래)
- **반응형 프리뷰** — **Desktop / Tablet / Mobile** 폭 전환, 미디어쿼리가 실제 기기처럼 반응
- **코드 뷰** — **Code**로 전환해 raw HTML 직접 편집 → **Design**으로 돌아오면 즉시 반영. viewport meta 자동 주입으로 export 시 반응형
- **선택 → 에이전트** — `onEditElement`를 넘기면 "이 선택에 지시 적용" 바가 떠서, 고른 요소를 에이전트에게 바꿔달라고 요청 가능

### 📊 스프레드시트 (`table`) — 진짜 스프레드시트

정적 표가 아니라 스프레드시트 엔진(Fortune-sheet) 위에서 동작합니다.

- **실시간 수식** — `=SUM(C2:C4)`, `=AVERAGE(...)`, `=A2*B2` 입력 시 계산. 셀참조·범위·함수 자동완성 지원
- **데이터로 온 수식** — 에이전트가 값으로 보낸 수식(`"=AVERAGE(B2:B4)"`)은 **로드 시 미리 계산**되어 결과가 바로 표시
- **전체 툴바** — 폰트, 숫자/통화/％ 서식, 굵게/기울임, 테두리, 셀 병합, 정렬, 다중 시트 — 데스크톱 수준
- 넓은 그리드에서 **상하좌우 부드러운 스크롤**
- **Export** — `.xlsx`(폰트/병합/서식 포함) 또는 `.csv`

### 🖼️ 슬라이드 (`slides`) — 프리 캔버스 덱

모든 요소가 움직이는 PowerPoint 스타일 편집기.

- **자유 배치** — 텍스트/이미지 요소 드래그·리사이즈, 가이드 스냅
- **인라인 편집** — 더블클릭 텍스트 편집, 굵게/크기/색/정렬 툴바
- **구조** — 슬라이드 추가/복제/삭제/순서, 썸네일 레일, 발표자 노트
- **테마·배경**, 발표 모드(전체화면, 방향키 이동)
- **Export** — `.pptx`, **Figma 복사**(에디터블 프레임으로 바로 붙여넣기), **PDF**(전 슬라이드)

### 📝 문서 (`document`) — Markdown / Word

- **클릭 편집** — 페이지를 Markdown으로 편집(GFM 렌더)
- **Export** — `.docx`, `.md`, `.pdf`, `.html`

### 📈 차트 (`chart`)

- **선/막대/영역/파이**, 한 번에 전환
- **데이터 인라인 편집** — 값 수정, 행 추가/삭제
- 시리즈(또는 파이 조각)별 **색상 변경**, 시리즈 이름, Y축 라벨, 스택 토글
- **Export** — `.pdf`(차트가 SVG라 선명) 또는 raw JSON

### 📁 파일 — 라운드트립

- **Import** — 드래그앤드롭 또는 파일 선택: **CSV · Excel · Markdown · HTML · JSON** → 편집 가능한 아티팩트로
- **Export** — 각 아티팩트를 네이티브 포맷으로, 그리고 범용 **standalone `.html`** · **PDF**(브라우저 인쇄)

### 🧰 모든 아티팩트 공통

- **실행취소/재실행** — `⌘Z` / `⌘⇧Z`(또는 툴바 버튼)로 *사용자* 편집을 되돌림(에이전트 스트리밍은 스택 오염 안 됨)
- **버전 히스토리** — `canvas.replace`마다 버전 스냅샷을 남겨 되짚어 보기 가능
- **에러 격리** — 렌더러가 throw해도 호스트 앱이 죽지 않고 인라인 폴백 표시
- **다중 캔버스** — `<CanvasProvider>`로 감싸 한 앱에 독립 인스턴스 여러 개

---

## 내 앱에 래핑하기

- **peerDependency:** React 18 또는 19 — 직접 제공. ESM 전용.
- **스타일:** `import "@langchain-canvas/react/styles.css"` 한 번.
- **인스턴스 격리:** `<CanvasProvider>`가 서브트리마다 독립 store 제공.
- **커스텀 렌더러:** `registry`로 타입 렌더 방식 추가/오버라이드.

```tsx
import { Canvas, mergeRegistries, builtinRenderers } from "@langchain-canvas/react";

const registry = mergeRegistries(builtinRenderers, {
  metric: ({ artifact }) => <div className="big-number">{artifact.data.value}</div>,
});

<Canvas registry={registry} />
```

### 백엔드 없이 — 픽스처 재생 / mock

```tsx
import { useCanvasReplay, scenarios } from "@langchain-canvas/react";

const { play } = useCanvasReplay();
useEffect(() => { play(scenarios.find((s) => s.id === "table")!.events); }, [play]);
```

```tsx
useCanvasStream({ mock: (msg) => (/차트|chart/i.test(msg) ? chartEvents : null) }); // null → 엔드포인트로
```

## 동작 방식

```
에이전트  ──SSE──▶  canvas 이벤트  ──▶  reconciler  ──▶  store  ──▶  렌더러
                  (create/append/patch/replace)   (순수 함수)              │
                                                                          ▼
                          사용자 편집 (입력 / 드래그 / 선택)  ──▶  같은 reconciler
```

reconciler는 단일 순수 함수 — 스트리밍 토큰, 사용자 편집, 새 버전 모두 여기를 거쳐 상태가 예측 가능하고 감사 가능합니다.

## 보안

에이전트 출력과 import된 파일은 신뢰불가로 취급합니다:

- HTML은 `sandbox="allow-scripts"` + **`allow-same-origin` 없음**인 iframe에서 렌더 — null 오리진이라 앱의 DOM·쿠키·스토리지에 접근 불가(Claude Artifacts 모델)
- PDF export는 **스크립트 비활성** 샌드박스 iframe에서 렌더 — 악성 페이지를 내보내도 내 오리진에서 아무것도 실행되지 않음
- import된 Markdown은 raw HTML 통과 없이 렌더

## 라이선스

MIT
