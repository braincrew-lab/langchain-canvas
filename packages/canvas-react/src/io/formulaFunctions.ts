/**
 * Custom formula functions for the precompute engine, plus the supported list.
 *
 * `fast-formula-parser` ships several classic functions as empty stubs
 * (SUMIFS / AVERAGEIFS / COUNTIFS / MATCH / MAX / MIN return nothing).
 * Registering implementations through the parser's `functions` config
 * overrides those stubs, so agent-supplied formulas cover the classic set
 * the tool docs promise.
 *
 * `SUPPORTED_FORMULA_FUNCTIONS` is the one list tool docstrings and the
 * verifier read. Every name on it is covered by a test in
 * `formula.test.ts` — extend the list only together with a test, so the
 * promise cannot drift from what actually evaluates.
 */

type Cell = string | number | boolean | null;

/**
 * Functions verified to evaluate on the agent path (data-supplied `"=..."`
 * strings). Mirrored by `SUPPORTED_FORMULA_FUNCTIONS` in the Python package;
 * a parity test keeps the two lists identical.
 */
export const SUPPORTED_FORMULA_FUNCTIONS: readonly string[] = [
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
];

/** The parser hands plain functions `{value, isArray}` wrappers — unwrap them. */
const unwrap = (arg: unknown): unknown =>
  arg !== null && typeof arg === "object" && !Array.isArray(arg) && "value" in (arg as object)
    ? (arg as { value: unknown }).value
    : arg;

/** Flatten a scalar-or-range argument into a flat cell list. */
const flat = (arg: unknown): Cell[] => {
  const value = unwrap(arg);
  return Array.isArray(value) ? ((value as unknown[]).flat(Infinity) as Cell[]) : [value as Cell];
};

/** A single-value argument (the first cell when a range was passed). */
const scalar = (arg: unknown): Cell => flat(arg)[0] ?? null;

const numbers = (values: unknown[]): number[] =>
  values.flatMap(flat).filter((v): v is number => typeof v === "number");

const ciEqual = (a: Cell, b: string): boolean => String(a ?? "").toLowerCase() === b.toLowerCase();

/**
 * Excel-style criteria match: a bare number/string means equality
 * (case-insensitive for text), a string starting with `<>`, `>=`, `<=`,
 * `=`, `>` or `<` compares against the rest (numeric when the rest parses
 * as a number, case-insensitive text otherwise). Wildcards are not
 * supported — the check tool's error text steers agents to exact criteria.
 */
const matchesCriteria = (value: Cell, criteria: Cell): boolean => {
  if (typeof criteria === "string") {
    const m = /^(<>|>=|<=|=|>|<)(.*)$/.exec(criteria);
    if (m) {
      const [, op, rest] = m;
      const num = rest.trim() === "" ? NaN : Number(rest);
      if (!Number.isNaN(num)) {
        if (op === "=") return value === num;
        if (op === "<>") return value !== num;
        if (typeof value !== "number") return false;
        return op === ">" ? value > num : op === "<" ? value < num : op === ">=" ? value >= num : value <= num;
      }
      if (op === "=") return ciEqual(value, rest);
      if (op === "<>") return !ciEqual(value, rest);
      const a = String(value ?? "").toLowerCase();
      const b = rest.toLowerCase();
      return op === ">" ? a > b : op === "<" ? a < b : op === ">=" ? a >= b : a <= b;
    }
    const num = criteria.trim() === "" ? NaN : Number(criteria);
    if (!Number.isNaN(num)) return value === num;
    return typeof value === "string" && ciEqual(value, criteria);
  }
  return value === criteria;
};

/** Flatten criteria-range/criteria pairs, checking each range matches `length`. */
const criteriaPairs = (args: unknown[], length: number): Array<{ range: Cell[]; criteria: Cell }> => {
  if (args.length === 0 || args.length % 2 !== 0) throw new Error("criteria come in range/criteria pairs");
  const pairs: Array<{ range: Cell[]; criteria: Cell }> = [];
  for (let i = 0; i < args.length; i += 2) {
    const range = flat(args[i]);
    if (range.length !== length) throw new Error("criteria ranges must match the first range's size");
    pairs.push({ range, criteria: scalar(args[i + 1]) });
  }
  return pairs;
};

const matchingIndexes = (pairs: Array<{ range: Cell[]; criteria: Cell }>, length: number): number[] => {
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    if (pairs.every(({ range, criteria }) => matchesCriteria(range[i], criteria))) out.push(i);
  }
  return out;
};

const truthy = (v: Cell): boolean => v === true || v === 1 || (typeof v === "string" && v.toUpperCase() === "TRUE");

const text = (v: Cell): string => (typeof v === "boolean" ? (v ? "TRUE" : "FALSE") : String(v ?? ""));

/**
 * The custom function table registered on every precompute parser. Plain
 * (context-free) functions: the parser materializes range references into
 * value grids before calling. A thrown error surfaces as the cell's `#ERR`.
 */
export function customFormulaFunctions(): Record<string, (...args: unknown[]) => Cell> {
  return {
    SUMIFS: (sumRange, ...rest) => {
      const sums = flat(sumRange);
      const pairs = criteriaPairs(rest, sums.length);
      return matchingIndexes(pairs, sums.length).reduce((acc, i) => {
        const v = sums[i];
        return typeof v === "number" ? acc + v : acc;
      }, 0);
    },
    AVERAGEIFS: (avgRange, ...rest) => {
      const values = flat(avgRange);
      const pairs = criteriaPairs(rest, values.length);
      const hits = matchingIndexes(pairs, values.length)
        .map((i) => values[i])
        .filter((v): v is number => typeof v === "number");
      if (hits.length === 0) throw new Error("AVERAGEIFS matched no cells");
      return hits.reduce((a, b) => a + b, 0) / hits.length;
    },
    COUNTIFS: (...rest) => {
      const length = flat(rest[0]).length;
      return matchingIndexes(criteriaPairs(rest, length), length).length;
    },
    MATCH: (lookup, range, matchType) => {
      const values = flat(range);
      const target = scalar(lookup);
      const rawMode = matchType === undefined ? null : scalar(matchType);
      const mode = typeof rawMode === "number" ? rawMode : 1;
      const equals = (v: Cell): boolean =>
        typeof target === "string" ? ciEqual(v, target) : v === target;
      if (mode === 0) {
        const idx = values.findIndex(equals);
        if (idx === -1) throw new Error("MATCH found no exact match");
        return idx + 1;
      }
      // 1: last value <= lookup (ascending data); -1: last value >= lookup
      // (descending data) — the classic binary-search semantics, linearly.
      let found = -1;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (typeof v !== typeof target || v === null || target === null) continue;
        if (mode === 1 ? (v as number | string) <= (target as number | string) : (v as number | string) >= (target as number | string)) found = i;
        else break;
      }
      if (found === -1) throw new Error("MATCH found no match");
      return found + 1;
    },
    MAX: (...args) => {
      const nums = numbers(args);
      return nums.length ? Math.max(...nums) : 0;
    },
    MIN: (...args) => {
      const nums = numbers(args);
      return nums.length ? Math.min(...nums) : 0;
    },
    TEXTJOIN: (delimiter, ignoreEmpty, ...parts) => {
      const values = parts.flatMap(flat);
      const kept = truthy(scalar(ignoreEmpty))
        ? values.filter((v) => v !== null && v !== "")
        : values;
      return kept.map(text).join(text(scalar(delimiter)));
    },
  };
}
