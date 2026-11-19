export type CapyErrorCode =
  | "invalid_arguments"
  | "configuration"
  | "writes_disabled"
  | "confirmation_required"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "invalid_request"
  | "conflict"
  | "payment_required"
  | "rate_limited"
  | "server_error"
  | "unavailable"
  | "invalid_response"
  | "response_too_large"
  | "network_error"
  | "timeout"
  | "aborted"
  | "stream_unavailable"
  | "redirect_refused";

export interface CapyErrorOptions {
  status?: number;
  retryAfterSeconds?: number;
}

export class CapyError extends Error {
  readonly code: CapyErrorCode;
  readonly status: number | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(code: CapyErrorCode, message: string, options: CapyErrorOptions = {}) {
    super(message);
    this.name = "CapyError";
    this.code = code;
    this.status = options.status;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

const KNOWN_TAGS = new Set([
  "capy/Unauthorized",
  "capy/Forbidden",
  "capy/ProjectNotFound",
  "capy/ThreadNotFound",
  "capy/SubagentNotFound",
  "capy/TaskNotFound",
  "capy/FileNotFound",
  "capy/InvalidRequest",
  "capy/PaidFeatureUnavailable",
  "capy/RateLimited",
  "capy/StreamUnavailable",
  "capy/EditNotAllowed",
  "capy/CrewRefused",
  "capy/DeviceAccessDenied",
  "capy/Conflict",
  "ModelSelection.Rejected",
]);

function safeTag(tag: string | undefined): string | undefined {
  return tag && KNOWN_TAGS.has(tag) ? tag : undefined;
}

function suffix(tag: string | undefined): string {
  return tag ? ` (${tag})` : "";
}

function rateLimitMessage(retryAfterSeconds: number | undefined): string {
  if (retryAfterSeconds !== undefined) {
    return `Capy rate-limited the request (HTTP 429, capy/RateLimited). Try again after ${retryAfterSeconds} second${retryAfterSeconds === 1 ? "" : "s"}. No retry was attempted.`;
  }
  return "Capy rate-limited the request (HTTP 429, capy/RateLimited). Try again later. No retry was attempted.";
}

/**
 * Maps an HTTP status and a known Capy error tag to a deliberate, safe message.
 * Upstream response text and request text are never included.
 */
export function apiError(
  status: number,
  rawTag: string | undefined,
  retryAfterSeconds?: number,
): CapyError {
  const tag = safeTag(rawTag);
  const known = suffix(tag);

  if (status === 401 || tag === "capy/Unauthorized") {
    return new CapyError(
      "unauthorized",
      "Capy rejected the API key (HTTP 401). Create or replace CAPY_API_KEY manually in Capy Settings > API, then restart Magpie.",
      { status },
    );
  }
  if (status === 403 || tag === "capy/Forbidden") {
    return new CapyError(
      "forbidden",
      `Capy denied access for this API key (HTTP 403${known}). The key may lack project access or the required permission.`,
      { status },
    );
  }
  if (status === 404) {
    if (tag === "capy/ProjectNotFound") {
      return new CapyError(
        "not_found",
        "The Capy project was not found or is not accessible with this API key (HTTP 404, capy/ProjectNotFound).",
        { status },
      );
    }
    if (tag === "capy/ThreadNotFound") {
      return new CapyError(
        "not_found",
        "The Capy thread was not found or is not accessible with this API key (HTTP 404, capy/ThreadNotFound).",
        { status },
      );
    }
    if (tag === "capy/SubagentNotFound") {
      return new CapyError(
        "not_found",
        "The Capy subagent was not found or is not accessible with this API key (HTTP 404, capy/SubagentNotFound).",
        { status },
      );
    }
    if (tag === "capy/TaskNotFound") {
      return new CapyError(
        "not_found",
        "The Capy task/subagent was not found or is not accessible with this API key (HTTP 404, capy/TaskNotFound).",
        { status },
      );
    }
    return new CapyError(
      "not_found",
      `The requested Capy resource was not found or is not accessible with this API key (HTTP 404${known}).`,
      { status },
    );
  }
  if (status === 429 || tag === "capy/RateLimited") {
    return new CapyError("rate_limited", rateLimitMessage(retryAfterSeconds), {
      status,
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    });
  }
  if (status === 402 || tag === "capy/PaidFeatureUnavailable") {
    return new CapyError(
      "payment_required",
      `This Capy action is not available on the current plan or credit balance (HTTP 402${known}).`,
      { status },
    );
  }
  if (status === 409) {
    return new CapyError(
      "conflict",
      `Capy refused the action because of the thread's current state (HTTP 409${known}).`,
      { status },
    );
  }
  if (status === 400 || tag === "capy/InvalidRequest" || tag === "ModelSelection.Rejected") {
    return new CapyError(
      "invalid_request",
      `Capy rejected the request as invalid (HTTP ${status}${known}). Check the tool arguments, project access, and model defaults.`,
      { status },
    );
  }
  if (status === 503 || tag === "capy/StreamUnavailable") {
    return new CapyError(
      "unavailable",
      "Capy could not serve the request or stream right now (HTTP 503). Try again later.",
      { status },
    );
  }
  if (status >= 500) {
    return new CapyError(
      "server_error",
      `Capy returned a server error (HTTP ${status}${known}). Try again later. No retry was attempted.`,
      { status },
    );
  }
  return new CapyError(
    "unavailable",
    `The Capy API request failed (HTTP ${status}${known}).`,
    { status },
  );
}

export function invalidArguments(message: string): CapyError {
  return new CapyError("invalid_arguments", message);
}

export function invalidResponse(): CapyError {
  return new CapyError(
    "invalid_response",
    "Capy returned a response that did not match the documented shape. No retry was attempted.",
  );
}

export function abortedError(): CapyError {
  return new CapyError("aborted", "The Capy request was cancelled before it completed.");
}

export function timeoutError(): CapyError {
  return new CapyError("timeout", "The Capy request timed out. No retry was attempted.");
}

export function networkError(): CapyError {
  return new CapyError(
    "network_error",
    "Could not reach the Capy API. Check network connectivity and try again.",
  );
}
