import { describe, expect, test } from "bun:test";
import { usageWindows } from "../src/usage.ts";

const balance = {
  currency: "USD" as const,
  remainingDollars: 10,
  unlimited: false,
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
};
const report = {
  from: balance.periodStart,
  to: balance.periodEnd,
  totals: {
    llmDollars: 2,
    imageDollars: 0,
    vmDollars: 0,
    totalDollars: 2,
    standaloneTokenFeeDollars: 0,
    billedDollars: 1.5,
  },
};

describe("usage windows", () => {
  test("numeric remaining keeps the unit, reset and period spend separate", () => {
    const windows = usageWindows(balance, report, null);
    expect(windows[0]).toMatchObject({
      name: "Capy credits",
      balance: 10,
      unit: "USD",
      resetsAt: balance.periodEnd,
    });
    expect(windows[1]?.display).toContain("$2.00 total");
    expect(windows[1]?.display).toContain("$1.50 billed");
    expect(windows[1]?.balance).toBeUndefined();
  });

  test("negative remaining is carried, not clamped to zero", () => {
    const windows = usageWindows({ ...balance, remainingDollars: -1.25 }, null, null);
    expect(windows[0]?.balance).toBe(-1.25);
    expect(windows[0]?.display).toContain("-$1.25 remaining");
  });

  test("unlimited and no-balance are distinct and never rendered as zero", () => {
    const unlimited = usageWindows({ ...balance, remainingDollars: null, unlimited: true }, null, null);
    expect(unlimited[0]).toMatchObject({ display: "Unlimited" });
    expect(unlimited[0]?.balance).toBeUndefined();

    const none = usageWindows({ ...balance, remainingDollars: null, unlimited: false }, null, null);
    expect(none[0]).toMatchObject({ display: "No credit balance" });
    expect(none[0]?.balance).toBeUndefined();
  });

  test("special numeric strings stay explicit strings", () => {
    const windows = usageWindows({ ...balance, remainingDollars: "Infinity" }, null, null);
    expect(windows[0]?.display).toBe("Infinity remaining");
    expect(windows[0]?.balance).toBeUndefined();
  });

  test("a report failure is surfaced on the period row, not hidden", () => {
    const windows = usageWindows(balance, null, "HTTP 503");
    expect(windows[0]?.balance).toBe(10);
    expect(windows[1]?.display).toBe("Unavailable: HTTP 503");
  });
});
