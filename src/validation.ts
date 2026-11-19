import { invalidArguments } from "./errors.ts";

export type JsonRecord = Record<string, unknown>;

export const REASONING_MODES = [
  "none",
  "instant",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type ReasoningMode = (typeof REASONING_MODES)[number];

export interface ModelSelection {
  modelId: string;
  reasoningMode?: ReasoningMode;
  modes?: {
    fast?: boolean;
    pro?: boolean;
    ultrafast?: boolean;
    daybreak?: boolean;
  };
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;
const TOKEN_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MESSAGE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{26}$/;
const PAGE_CURSOR_PATTERN = /^\d{1,15}:.+$/;
const DISALLOWED_TEXT_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ALL_CONTROLS_OR_SPACE = /[\s\u0000-\u001f\u007f]/;

export function asRecord(value: unknown, label = "arguments"): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidArguments(`${label} must be a JSON object.`);
  }
  return value as JsonRecord;
}

export function validateToolArgs(value: unknown, allowed: readonly string[]): JsonRecord {
  const args = asRecord(value);
  const allow = new Set(allowed);
  for (const key of Object.keys(args)) {
    if (!allow.has(key)) {
      const allowedText =
        allowed.length > 0
          ? `Allowed arguments: ${allowed.join(", ")}.`
          : "This tool takes no arguments.";
      throw invalidArguments(`Unknown argument. ${allowedText}`);
    }
  }
  return args;
}

function checkText(value: string, field: string, maxLength: number): void {
  if (value.trim().length === 0) {
    throw invalidArguments(`${field} must not be empty or whitespace.`);
  }
  if (value.length > maxLength) {
    throw invalidArguments(`${field} must be at most ${maxLength} characters.`);
  }
  if (DISALLOWED_TEXT_CONTROLS.test(value)) {
    throw invalidArguments(`${field} contains a disallowed control character.`);
  }
}

export function readText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw invalidArguments(`${field} must be a string.`);
  }
  checkText(value, field, maxLength);
  return value;
}

export function readOptionalText(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return readText(value, field, maxLength);
}

export function readId(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) {
    throw invalidArguments(
      `${field} must be a non-empty URL-safe Capy id of at most 191 characters (letters, digits, ".", "_", ":", "-").`,
    );
  }
  return value;
}

export function readToken(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    !TOKEN_PATTERN.test(value)
  ) {
    throw invalidArguments(
      `${field} must be a non-empty token of at most ${maxLength} characters using letters, digits, ".", "_", ":", or "-".`,
    );
  }
  return value;
}

export function readOptionalToken(
  value: unknown,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  return readToken(value, field, maxLength);
}

export function readInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw invalidArguments(`${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function readOptionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  return readInteger(value, field, min, max);
}

export function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw invalidArguments(`${field} must be true or false.`);
  }
  return value;
}

export function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw invalidArguments(`${field} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function readMessageCursor(value: unknown, field: string): string {
  if (typeof value !== "string" || !MESSAGE_CURSOR_PATTERN.test(value)) {
    throw invalidArguments(`${field} must be a 26-character Capy transcript cursor.`);
  }
  return value;
}

export function readOptionalMessageCursor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readMessageCursor(value, field);
}

export function readPageCursor(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    ALL_CONTROLS_OR_SPACE.test(value) ||
    !PAGE_CURSOR_PATTERN.test(value)
  ) {
    throw invalidArguments(`${field} must be a Capy thread-list cursor returned by list_threads.`);
  }
  return value;
}

export function readOptionalPageCursor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readPageCursor(value, field);
}

export function readWatchCursor(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    ALL_CONTROLS_OR_SPACE.test(value)
  ) {
    throw invalidArguments(`${field} must be a non-empty Capy event cursor without whitespace.`);
  }
  return value;
}

export function readOptionalWatchCursor(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return readWatchCursor(value, field);
}

export function readModelSelection(value: unknown, field: string): ModelSelection | undefined {
  if (value === undefined) return undefined;
  const selection = asRecord(value, field);
  const allowed = new Set(["modelId", "reasoningMode", "modes"]);
  for (const key of Object.keys(selection)) {
    if (!allowed.has(key)) {
      throw invalidArguments(
        `${field} only accepts modelId, reasoningMode, and modes.`,
      );
    }
  }
  const modelId = readText(selection.modelId, `${field}.modelId`, 191);
  const reasoningMode =
    selection.reasoningMode === undefined
      ? undefined
      : readEnum(selection.reasoningMode, `${field}.reasoningMode`, REASONING_MODES);
  let modes: ModelSelection["modes"];
  if (selection.modes !== undefined) {
    const rawModes = asRecord(selection.modes, `${field}.modes`);
    const modeKeys = new Set(["fast", "pro", "ultrafast", "daybreak"]);
    for (const key of Object.keys(rawModes)) {
      if (!modeKeys.has(key)) {
        throw invalidArguments(
          `${field}.modes only accepts fast, pro, ultrafast, and daybreak.`,
        );
      }
    }
    modes = {};
    for (const key of ["fast", "pro", "ultrafast", "daybreak"] as const) {
      if (rawModes[key] !== undefined) modes[key] = readBoolean(rawModes[key], `${field}.modes.${key}`);
    }
  }
  return {
    modelId,
    ...(reasoningMode !== undefined ? { reasoningMode } : {}),
    ...(modes !== undefined ? { modes } : {}),
  };
}

export function readOptionalModelSelection(
  value: unknown,
  field: string,
): ModelSelection | undefined {
  return readModelSelection(value, field);
}

export function readOpaqueCursor(value: unknown, field: string, maxLength = 512): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    ALL_CONTROLS_OR_SPACE.test(value)
  ) {
    throw invalidArguments(
      `${field} must be a non-empty opaque cursor of at most ${maxLength} characters without whitespace.`,
    );
  }
  return value;
}

export function readOptionalOpaqueCursor(
  value: unknown,
  field: string,
  maxLength = 512,
): string | undefined {
  if (value === undefined) return undefined;
  return readOpaqueCursor(value, field, maxLength);
}
