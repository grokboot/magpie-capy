import { CapyError } from "./errors.ts";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CallControl {
  readonly signal: AbortSignal;
  timedOut(): boolean;
  cleanup(): void;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new CapyError("aborted", "The Capy request was cancelled before it started.");
  }
}

export function createCallControl(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): CallControl {
  const controller = new AbortController();
  let timeoutReached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", onParentAbort, { once: true });
  }

  timer = setTimeout(() => {
    timeoutReached = true;
    controller.abort();
  }, timeoutMs);
  (timer as { unref?: () => void }).unref?.();

  return {
    signal: controller.signal,
    timedOut: () => timeoutReached,
    cleanup() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
}

export async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed or aborted.
  }
}

export async function readTextBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  let finished = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new CapyError(
          "response_too_large",
          `Capy returned more than the ${maxBytes}-byte response limit. No retry was attempted.`,
        );
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    finished = true;
    return parts.join("");
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed or aborted.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing an already-released reader is harmless.
    }
  }
}
