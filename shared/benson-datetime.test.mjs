import assert from "node:assert/strict";
import test from "node:test";

import { formatUserDatetime, UserDatetimeError } from "./benson-datetime.mjs";

const cases = [
  ["2026-09-24T05:00:00Z", "Asia/Jerusalem", "2026-09-23T06:00:30Z", "מחר ב־08:00"],
  ["2026-03-27T21:30:00Z", "Asia/Jerusalem", "2026-03-27T20:30:00Z", "מחר ב־00:30"],
  ["2026-10-25T00:30:00Z", "Asia/Jerusalem", "2026-10-24T22:30:00Z", "היום ב־02:30"],
  ["2026-12-15T09:05:00+02:00", "Asia/Jerusalem", "2026-09-23T06:00:30Z", "15 בדצמבר 2026 בשעה 09:05"],
];

test("shared formatter preserves Hebrew date presentation across day and DST boundaries", () => {
  for (const [value, timezone, now, expected] of cases) {
    assert.equal(formatUserDatetime(value, timezone, { now }), expected);
  }
});

test("shared formatter rejects invalid or offset-free inputs", () => {
  for (const value of ["2026-02-30T10:00:00Z", "2026-01-01T10:00:00+24:00", "garbage"]) {
    assert.throws(() => formatUserDatetime(value, "Asia/Jerusalem", { now: cases[0][2] }), UserDatetimeError);
  }
  assert.throws(
    () => formatUserDatetime("2026-09-24T05:00:00", "Asia/Jerusalem", { now: cases[0][2] }),
    { message: "user-facing datetime must include timezone" },
  );
  assert.throws(
    () => formatUserDatetime(cases[0][0], "Invalid/Timezone", { now: cases[0][2] }),
    { message: "invalid timezone: Invalid/Timezone" },
  );
  assert.throws(
    () => formatUserDatetime(cases[0][0], undefined, { now: cases[0][2] }),
    { message: "invalid timezone: undefined" },
  );
});
