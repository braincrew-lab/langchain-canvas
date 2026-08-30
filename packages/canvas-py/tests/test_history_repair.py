import pytest
from langchain_core.language_models.fake_chat_models import GenericFakeChatModel
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from langchain_canvas.agent import create_canvas_agent
from langchain_canvas.history_repair import INTERRUPTED_RESULT, repair_orphaned_tool_calls


def _call(call_id: str) -> dict:
    return {"id": call_id, "name": "write_canvas", "args": {}, "type": "tool_call"}


def test_fills_missing_tool_result_directly_after_ai_message():
    messages = [
        HumanMessage("make a deck"),
        AIMessage("", tool_calls=[_call("toolu_1")]),
        HumanMessage("수정해줘"),
    ]
    repaired = repair_orphaned_tool_calls(messages)
    kinds = [type(m).__name__ for m in repaired]
    assert kinds == ["HumanMessage", "AIMessage", "ToolMessage", "HumanMessage"]
    filler = repaired[2]
    assert isinstance(filler, ToolMessage)
    assert filler.tool_call_id == "toolu_1"
    assert filler.status == "error"
    assert filler.content == INTERRUPTED_RESULT
    assert len(messages) == 3  # input untouched


def test_partial_parallel_results_only_fill_the_missing_one():
    messages = [
        AIMessage("", tool_calls=[_call("a"), _call("b")]),
        ToolMessage("ok", tool_call_id="a"),
    ]
    repaired = repair_orphaned_tool_calls(messages)
    assert [m.tool_call_id for m in repaired[1:]] == ["a", "b"]


def test_complete_history_is_unchanged():
    messages = [
        AIMessage("", tool_calls=[_call("a")]),
        ToolMessage("ok", tool_call_id="a"),
        AIMessage("done"),
    ]
    assert repair_orphaned_tool_calls(messages) == messages


def _orphaned_history() -> dict:
    return {
        "messages": [
            HumanMessage("make a deck"),
            AIMessage("", tool_calls=[_call("toolu_1")]),
            HumanMessage("계속해줘"),
        ]
    }


def test_invoke_repairs_orphaned_tool_calls_without_raising():
    """The sync wrap_model_call hook still works through invoke()."""
    fake_model = GenericFakeChatModel(messages=iter([AIMessage("all set")]))
    agent = create_canvas_agent(model=fake_model, tools=[])

    result = agent.invoke(_orphaned_history())

    assert result["messages"]  # the run completed without raising


@pytest.mark.asyncio
async def test_astream_repairs_orphaned_tool_calls_without_raising():
    """Regression test: astream() used to raise NotImplementedError because
    repair_tool_history was a sync-only @wrap_model_call middleware.
    """
    fake_model = GenericFakeChatModel(messages=iter([AIMessage("all set")]))
    agent = create_canvas_agent(model=fake_model, tools=[])

    events = [event async for event in agent.astream(_orphaned_history())]

    assert events  # the stream completed without raising NotImplementedError
