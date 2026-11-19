import { throwIfAborted } from "./http.ts";

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}

export type SseEndReason = "eof" | "max_bytes" | "max_events" | "stopped";

export interface SseConsumeOptions {
  maxBytes: number;
  maxEvents: number;
  signal?: AbortSignal;
  onEvent(frame: SseFrame): boolean | void;
}

export interface SseConsumeResult {
  reason: SseEndReason;
  bytes: number;
  events: number;
}

type Dispatch = (frame: SseFrame) => boolean;

class SseParser {
  private buffer = "";
  private eventName = "";
  private dataLines: string[] = [];
  private frameId: string | undefined;
  private retry: number | undefined;

  push(text: string, dispatch: Dispatch): boolean {
    this.buffer += text;
    for (;;) {
      const line = this.nextLine();
      if (line === null) return true;
      if (!this.processLine(line, dispatch)) return false;
    }
  }

  end(dispatch: Dispatch): boolean {
    if (this.buffer === "\r") {
      this.buffer = "";
      return this.processLine("", dispatch);
    }
    this.buffer = "";
    this.eventName = "";
    this.dataLines = [];
    this.frameId = undefined;
    this.retry = undefined;
    return true;
  }

  private nextLine(): string | null {
    for (let index = 0; index < this.buffer.length; index++) {
      const char = this.buffer[index];
      if (char === "\n") {
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      if (char === "\r") {
        if (index + 1 === this.buffer.length) return null;
        const width = this.buffer[index + 1] === "\n" ? 2 : 1;
        const line = this.buffer.slice(0, index);
        this.buffer = this.buffer.slice(index + width);
        return line;
      }
    }
    return null;
  }

  private processLine(line: string, dispatch: Dispatch): boolean {
    if (line.length === 0) return this.dispatchFrame(dispatch);
    if (line.startsWith(":")) return true;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.eventName = value;
        break;
      case "data":
        this.dataLines.push(value);
        break;
      case "id":
        if (!value.includes("\u0000")) this.frameId = value;
        break;
      case "retry":
        if (/^\d{1,10}$/.test(value)) this.retry = Number(value);
        break;
      default:
        break;
    }
    return true;
  }

  private dispatchFrame(dispatch: Dispatch): boolean {
    let keepGoing = true;
    if (this.dataLines.length > 0) {
      const frame: SseFrame = {
        event: this.eventName || "message",
        data: this.dataLines.join("\n"),
        ...(this.frameId !== undefined ? { id: this.frameId } : {}),
        ...(this.retry !== undefined ? { retry: this.retry } : {}),
      };
      keepGoing = dispatch(frame) !== false;
    }
    this.eventName = "";
    this.dataLines = [];
    this.frameId = undefined;
    this.retry = undefined;
    return keepGoing;
  }
}

export async function consumeSse(
  body: ReadableStream<Uint8Array>,
  options: SseConsumeOptions,
): Promise<SseConsumeResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const signal = options.signal;
  let bytes = 0;
  let events = 0;
  let limitReached = false;
  let drained = false;

  const handleFrame = (frame: SseFrame): boolean => {
    if (events >= options.maxEvents) {
      limitReached = true;
      return false;
    }
    events += 1;
    return options.onEvent(frame) !== false;
  };
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    throwIfAborted(signal);
    for (;;) {
      const { done, value } = await reader.read();
      throwIfAborted(signal);
      if (done) {
        const tail = decoder.decode();
        if (tail.length > 0 && !parser.push(tail, handleFrame)) {
          drained = true;
          return { reason: limitReached ? "max_events" : "stopped", bytes, events };
        }
        drained = true;
        const keepGoing = parser.end(handleFrame);
        if (!keepGoing) {
          return { reason: limitReached ? "max_events" : "stopped", bytes, events };
        }
        if (events >= options.maxEvents) return { reason: "max_events", bytes, events };
        return { reason: "eof", bytes, events };
      }

      bytes += value.byteLength;
      if (bytes > options.maxBytes) {
        return { reason: "max_bytes", bytes, events };
      }

      if (!parser.push(decoder.decode(value, { stream: true }), handleFrame)) {
        return { reason: limitReached ? "max_events" : "stopped", bytes, events };
      }
      if (events >= options.maxEvents) {
        return { reason: "max_events", bytes, events };
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (!drained) {
      try {
        await reader.cancel();
      } catch {
        // The fetch body can already be closed after an abort.
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // Releasing an already-released reader is harmless.
    }
  }
}
