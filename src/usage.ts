import type { UsageAmount, UsageBalance, UsageReport } from "./client.ts";

export interface UsageWindow {
  name: string;
  display?: string;
  used?: number;
  resetsAt?: string;
  span?: number;
  amount?: number;
  limit?: number;
  unit?: string;
  balance?: number;
}

export interface HostUsage {
  plan: string;
  user: string;
  windows: UsageWindow[];
  balance?: string;
  error?: string;
  signIn?: "expired" | "kept" | "renewed" | "gone";
}

function amountText(value: UsageAmount): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return value;
}

function dollars(value: UsageAmount): string {
  if (typeof value !== "number") return `$${value}`;
  const fixed = Math.abs(value) < 0.01 && value !== 0 ? value.toFixed(4) : value.toFixed(2);
  return `${value < 0 ? "-" : ""}$${fixed.replace(/^-/, "")}`;
}

export function usageWindows(
  balance: UsageBalance,
  report: UsageReport | null,
  reportError: string | null,
): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const resetsAt = balance.periodEnd ?? undefined;

  if (balance.unlimited) {
    windows.push({
      name: "Capy credits",
      display: "Unlimited",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  } else if (balance.remainingDollars === null) {
    windows.push({
      name: "Capy credits",
      display: "No credit balance",
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  } else if (typeof balance.remainingDollars === "number") {
    windows.push({
      name: "Capy credits",
      display: `${dollars(balance.remainingDollars)} remaining`,
      balance: balance.remainingDollars,
      unit: balance.currency,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  } else {
    windows.push({
      name: "Capy credits",
      display: `${amountText(balance.remainingDollars)} remaining`,
      unit: balance.currency,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  }

  if (report) {
    windows.push({
      name: "Current period",
      display: `${dollars(report.totals.totalDollars)} total · ${dollars(report.totals.billedDollars)} billed`,
      unit: balance.currency,
      ...(resetsAt !== undefined ? { resetsAt } : {}),
    });
  } else if (reportError) {
    windows.push({
      name: "Current period",
      display: `Unavailable: ${reportError}`,
      unit: balance.currency,
    });
  }

  return windows;
}
