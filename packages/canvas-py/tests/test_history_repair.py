from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

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
