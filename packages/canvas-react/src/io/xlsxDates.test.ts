import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { xlsxToSheets } from "./xlsx";

/**
 * A spreadsheet date is a calendar day, not an instant.
 *
 * exceljs hands one over as a `Date` at UTC midnight, so reading its parts
 * back in local time moves the day anywhere west of UTC: 2026-03-09 showed as
 * 2026-03-08 in New York. Nobody here saw it, because Korea is UTC+9 and the
 * day lands the same.
 *
 * The golden parity test cannot catch this on its own — it pins `TZ=UTC` so
 * the golden means one thing, and under UTC the local and UTC readings agree.
 * This runs the same file in four zones instead, so a return to local parts
 * fails here even while parity stays green.
 */
const FIXTURE = join(process.cwd(), "src", "io", "__fixtures__", "xlsx-parity.xlsx");
const ZONES = ["UTC", "Asia/Seoul", "America/New_York", "Pacific/Honolulu"];
const started = process.env.TZ;

afterAll(() => {
  process.env.TZ = started;
});

/** Every date cell of the fixture's first sheet, addressed, as it renders. */
async function datesIn(zone: string): Promise<Record<string, string>> {
  process.env.TZ = zone;
  const bytes = readFileSync(FIXTURE);
  const { sheets } = await xlsxToSheets(
    bytes as unknown as ArrayBuffer,
    async () => (await import("exceljs")).default,
  );
  const dates: Record<string, string> = {};
  for (const cell of sheets[0].celldata as Array<Record<string, any>>) {
    if (cell.v?.ct?.t === "d") dates[`${cell.r}_${cell.c}`] = cell.v.m;
  }
  return dates;
}

describe("xlsx dates", () => {
  it("shows the same day in every timezone", async () => {
    // One at a time: the zone is process-wide, and a conversion started in
    // one zone would otherwise finish in whichever zone the next test set.
    const seen: Array<Record<string, string>> = [];
    for (const zone of ZONES) seen.push(await datesIn(zone));

    // The fixture carries a plain date and one written through a format with
    // literal text, so both paths through the formatter are covered.
    expect(seen[0]).toEqual({ "1_5": "2026-03-09", "2_5": '2025"년 "12"월 "28일' });
    for (let i = 1; i < ZONES.length; i++) {
      expect(seen[i], `dates differ under ${ZONES[i]}`).toEqual(seen[0]);
    }
  });
});
