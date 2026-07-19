<div align="center">

# langchain-canvas

**LangChain 에이전트를 위한 라이브 캔버스.**

에이전트는 평범한 툴만 작성하면 됩니다. 사용자는 캔버스를 얻습니다 — 채팅 옆에서
문서·차트·표·완전한 HTML 페이지가 실시간으로 렌더되고, 쓰이는 동안 스트리밍되며,
스스로 버전을 남기고, 어떤 요소든 클릭해서 편집할 수 있는 패널.

품질 기준: Genspark · ChatGPT Canvas · Claude Artifacts.

</div>

<div align="center">

📖 [English](README.md) · **한국어**

</div>

```
┌───────────────────────────┬─────────────────────────────────────┐
│  채팅                     │  캔버스                              │
│                           │  ┌────────────────────────────────┐  │
│  › 가격 페이지 만들어줘   │  │  Starter   Pro   Enterprise    │  │
│                           │  │  $0        $20    문의하기      │  │
│  ✓ 페이지 완성 — 요소를   │  │  [ hover → 하이라이트,         │  │
│    클릭해 편집하세요.     │  │    click → 이 요소만 편집 ]    │  │
│                           │  └────────────────────────────────┘  │
└───────────────────────────┴─────────────────────────────────────┘
```

---

## 목차

- [백엔드 없이 보기 (스키마 리플레이)](#백엔드-없이-보기-스키마-리플레이)
- [내 앱에 캔버스 붙이기](#내-앱에-캔버스-붙이기)
- [세 가지 핵심 아이디어](#세-가지-핵심-아이디어)
- [기능](#기능)
- [새 아티팩트 타입 추가하기](#새-아티팩트-타입-추가하기)
- [문서](#문서) · [로드맵](#로드맵) · [라이선스](#라이선스)

---

## 백엔드 없이 보기 (스키마 리플레이)

캔버스는 전적으로 **와이어 스키마**(= `StreamEvent` 스트림)로 정의됩니다. 그래서
백엔드도, LLM도, API 키도 없이 **픽스처만으로** 렌더링할 수 있습니다. 가장 빠르게
확인하고 렌더러를 개발하는 방법입니다:

```bash
pnpm install
pnpm dev:web                  # → http://localhost:3000/replay 열기
```

시나리오(HTML 페이지 / 스트리밍 문서 / 차트 / 표)를 골라, 실제 에이전트가
구동하는 것과 똑같이 렌더되는 걸 보세요. 코드로는:

```tsx
import { Canvas, useCanvasReplay, scenarios } from "@braincrew-lab/langchain-canvas";

const { play } = useCanvasReplay();
play(scenarios[0].events);    // 스키마 → 화면, 네트워크 없음
```

> LangChain/LangGraph 백엔드는 이 **동일한 이벤트**를 LangGraph의 `custom` 스트림
> 채널로 emit 합니다. 프론트엔드는 이벤트가 픽스처에서 왔는지 실제 에이전트에서
> 왔는지 신경 쓰지 않습니다. 지금은 픽스처로 개발하고, 백엔드가 준비되면 실제
> 에이전트를 꽂으면 됩니다.

## 내 앱에 캔버스 붙이기

설치 두 번, 코드 두 조각.

> 아직 PyPI/npm 에 배포 전입니다 — 현재는 이 레포에서 직접 설치하세요
> (`apps/server/pyproject.toml`, `pnpm-workspace.yaml` 의 워크스페이스 설정 참고).

### 백엔드 (Python) — 툴에서 아티팩트 emit

```python
from langchain.tools import tool, ToolRuntime
from langchain_canvas import Canvas, create_canvas_agent, sse_from_agent

@tool
def build_page(brief: str, runtime: ToolRuntime) -> str:
    """HTML 페이지를 만들어 캔버스에 보여준다."""
    canvas = Canvas.from_runtime(runtime)          # 1. 캔버스 가져오기
    page = canvas.open_html(title=brief)           # 2. 아티팩트 열기
    page.set_html("<h1>Hello</h1>")                # 3. 채우기 (.append(...) 으로 스트리밍도 가능)
    page.complete()
    return "페이지를 캔버스에 띄웠습니다."

agent = create_canvas_agent(model="anthropic:claude-sonnet-4-5", tools=[build_page])
```

FastAPI 로 SSE 스트리밍:

```python
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

app = FastAPI()

class Body(BaseModel):
    thread_id: str
    message: str

@app.post("/api/chat")
async def chat(body: Body):
    inputs = {"messages": [{"role": "user", "content": body.message}]}
    config = {"configurable": {"thread_id": body.thread_id}}
    return StreamingResponse(sse_from_agent(agent, inputs, config=config),
                             media_type="text/event-stream")
```

### 프론트엔드 (React) — 렌더링

```tsx
"use client";
import { Canvas, useCanvasStream } from "@braincrew-lab/langchain-canvas";
import "@braincrew-lab/langchain-canvas/styles.css";

export default function Page() {
  const { sendMessage, messages, canvas, isStreaming, editSelection } =
    useCanvasStream({ endpoint: "/api/chat" });

  return (
    <div style={{ display: "grid", gridTemplateColumns: "400px 1fr", height: "100vh" }}>
      <YourChatUI messages={messages} onSend={sendMessage} busy={isStreaming} />
      <Canvas onEditElement={editSelection} />   {/* 클릭-편집이 연결됨 */}
    </div>
  );
}
```

끝입니다. `useCanvasStream` 이 메시지를 보내고 스트림을 파싱해 대화(`messages`)와
캔버스(`canvas`)를 동기화하며, `<Canvas />` 는 에이전트가 emit 한 것을 그립니다.
채팅 말풍선만 직접 만들면, 캔버스는 완성되어 있습니다.

양쪽 전체 예제는 [`docs/03-getting-started.md`](docs/03-getting-started.md) 에 있습니다.

---

## 세 가지 핵심 아이디어

최신 캔버스 제품들(ChatGPT `canmore`, Claude `antArtifact`, Vercel AI SDK data
parts)은 모두 같은 설계로 수렴합니다. `langchain-canvas` 는 그 설계를 최소한으로 담았습니다:

1. **아티팩트는 emit 하지, 파싱하지 않는다.** 에이전트는 툴을 호출해 캔버스를 엽니다
   — 프롬프트 안에 매직 토큰 같은 건 없습니다.
2. **`type` 문자열이 렌더러를 고른다.** 백엔드는 데이터(`{ type, data }`)만 보내고
   JSX 는 보내지 않습니다. 프론트엔드가 `type → 컴포넌트` 레지스트리를 소유합니다.
3. **안정적인 `id` 가 모든 걸 리컨실한다.** 같은 `id` → 제자리 갱신, 새 `id` → 새
   아티팩트. 이 규칙 하나가 스트리밍·패치·버전관리를 전부 굴립니다.

내부적으로는 LangChain 1.x 의 네이티브 커스텀 스트림 채널
(`ToolRuntime.stream_writer` → `stream_mode="custom"`) 위에서 동작합니다 — 프레임워크 포크 없음.

## 기능

- 🌐 **HTML이 베이스** — 에이전트가 자기완결형 페이지를 emit 하고, CSP 샌드박스
  iframe 에서 렌더됩니다. 문서·차트·표는 그 위의 구조화된 편의 타입입니다.
- 🖱️ **클릭-편집** — hover 하이라이트, 클릭 선택 후 자연어 지시(에이전트가 그 요소만
  수술적으로 패치)를 하거나, **스타일 패널**(색/크기/굵기/정렬)과 **더블클릭 인라인
  텍스트 편집**을 씁니다.
- ⚡ **O(1) 요소 패치** — `canvas.node_patch` 가 페이지를 통째로 다시 보내지 않고
  `data-cid` 로 한 요소만 교체합니다.
- 📝 **스트리밍 문서** — 마크다운이 토큰 단위로 실시간 렌더.
- 📊 **차트** & 📋 **표** — line/bar/area/pie, 정돈된 rows 위의 sticky 헤더 그리드.
- 📦 **파일 export** — 어떤 아티팩트든 자기완결형 **`.html`**, 그리고 `.md` / `.csv` / `.json`.
- 🗂️ **탭 + 버전관리** — 아티팩트 전환, 모든 버전 넘겨보기.
- 🧩 **교체 가능한 렌더러** & 🔌 **헤드리스 코어** — `type → 컴포넌트` 등록, 또는 리컨실러/SSE 클라이언트만 써서 직접 UI 구성.
- 🧵 **양쪽 타입 안전** — Pydantic 과 TypeScript 가 하나의 와이어 프로토콜을 미러링.

## 새 아티팩트 타입 추가하기

세 단계, 전송 계층 변경 0:

1. 데이터 shape 를 양쪽 `protocol` 모듈(Python + TS)에 추가.
2. 툴에서 emit (`canvas.open_*`, 또는 raw `canvas.create`).
3. 렌더러 등록: `<Canvas registry={{ ...builtinRenderers, kpi: KpiRenderer }} />`.

## 문서

- [아키텍처](docs/01-architecture.md) — 경계와 그 이유.
- [와이어 프로토콜](docs/02-protocol.md) — 모든 이벤트와 리컨실 효과.
- [시작하기](docs/03-getting-started.md) — 앞뒤 전체 복붙 예제.
- [기여 가이드](CONTRIBUTING.md).

## 로드맵

- 원클릭 **publish → 공유 URL** 및 `<iframe>` 임베드
- 멀티에이전트 **병렬 영역 채우기** (서브에이전트들이 서로 다른 영역을 실시간 패치)
- 셀프-크리틱 비주얼 루프 (에이전트가 자기 페이지를 스크린샷하며 개선)
- `code` 아티팩트 (Monaco + diff) · HTML → React 컴포넌트 export
- LangGraph 체크포인터 기반의 새로고침에도 살아남는 버전 히스토리

## 라이선스

[MIT](LICENSE)
