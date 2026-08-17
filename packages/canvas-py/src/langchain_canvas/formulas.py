"""Formula support surface for table artifacts.

Table cells may hold spreadsheet formula strings (values starting with
``=``). The client precomputes their results on load with a small MIT
formula engine, so an agent-supplied formula shows its value — and stays a
formula in the stored artifact, editable later.

``SUPPORTED_FORMULA_FUNCTIONS`` is the contract agents can rely on for
data-supplied formulas. It mirrors the constant of the same name in the
TypeScript package (``canvas-react/src/io/formulaFunctions.ts``), where
every listed name is covered by an evaluation test; a parity test keeps
the two lists identical, so this promise cannot drift from what actually
evaluates.

Cell references use on-screen coordinates: row 1 is the header row, data
rows start at row 2 — ``=SUM(B2:B4)`` sums the first three data rows of
the second column.
"""

from __future__ import annotations

SUPPORTED_FORMULA_FUNCTIONS: tuple[str, ...] = (
    "AVERAGE",
    "AVERAGEIF",
    "AVERAGEIFS",
    "COUNT",
    "COUNTIF",
    "COUNTIFS",
    "DATE",
    "EOMONTH",
    "IF",
    "IFERROR",
    "INDEX",
    "MATCH",
    "MAX",
    "MIN",
    "ROUND",
    "SUM",
    "SUMIF",
    "SUMIFS",
    "TEXTJOIN",
    "TODAY",
    "VLOOKUP",
)
"""Functions verified to evaluate for data-supplied ``"=..."`` cells."""


def formula_guidance() -> str:
    """Tool-docstring text describing formula support, built from the constant.

    Append this to the description of any tool that writes table rows, so
    the promised function list always comes from the same constant the
    engine tests cover.
    """
    names = ", ".join(SUPPORTED_FORMULA_FUNCTIONS)
    return (
        "Table cells may hold spreadsheet formulas as strings starting with '=' "
        "(for example '=SUMIFS(B2:B10, A2:A10, \"West\")'). Row 1 is the header "
        "row; data rows start at row 2. Supported functions: " + names + ". "
        "Dynamic-array functions (XLOOKUP, FILTER, SORT, UNIQUE, LET) are not "
        "supported — use classic equivalents such as SUMIFS, MATCH or TEXTJOIN."
    )
