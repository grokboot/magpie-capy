import { describe, expect, test } from "bun:test";
import { CapyError } from "../src/errors.ts";
import { consumeSse, type SseFrame } from "../src/sse.ts";

function chunkedResponse(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = queue.shift();
      if (!chunk) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
    },
  });
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe("consumeSse", () => {
  test("parses CRLF split across chunks, comments, multiline data, ids, and retry", async () => {
    const frames: SseFrame[] = [];
    const chunks = [
      bytes(": comment\r\nevent: status\r"),
      bytes("\ndata: {\"a\":1}\r\n\r\nevent: transcript\r\nid: 01J\r\ndata: line1\r\ndata: line2\r\n"),
      bytes("\r\nretry: 1500\r\ndata: {}\r\n\r\n"),
    ];
    const result = await consumeSse(chunkedResponse(chunks), {
      maxBytes: 10_000,
      maxEvents: 10,
      onEvent: (frame) => {
        frames.push(frame);
      },
    });

    expect(result.reason).toBe("eof");
    expect(frames[0]).toEqual({ event: "status", data: "{\"a\":1}" });
    expect(frames[1]).toEqual({
      event: "transcript",
      id: "01J",
      data: "line1\nline2",
    });
    expect(frames[2]).toEqual({ event: "message", data: "{}", retry: 1500 });
  });

  test("decodes a multi-byte character split across byte chunks", async () => {
    const text = "event: transcript\ndata: {\"text\":\"héllo 🦩 世界\"}\n\n";
    const encoded = bytes(text);
    const split = encoded.indexOf(0xf0) + 2;
    const frames: SseFrame[] = [];
    const result = await consumeSse(
      chunkedResponse([encoded.slice(0, split), encoded.slice(split)]),
      {
        maxBytes: 10_000,
        maxEvents: 10,
        onEvent: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(result.reason).toBe("eof");
    expect(frames[0]?.data).toBe("{\"text\":\"héllo 🦩 世界\"}");
  });

  test("discards a truncated multibyte event at EOF without dropping earlier events", async () => {
    const prefix = bytes("event: ok\ndata: first\n\nevent: x\ndata: h");
    const input = new Uint8Array(prefix.length + 1);
    input.set(prefix);
    input[prefix.length] = 0xc3;
    const frames: SseFrame[] = [];

    const result = await consumeSse(chunkedResponse([input]), {
      maxBytes: 10_000,
      maxEvents: 10,
      onEvent: (frame) => {
        frames.push(frame);
      },
    });

    expect(result.reason).toBe("eof");
    expect(result.events).toBe(1);
    expect(frames).toEqual([{ event: "ok", data: "first" }]);
  });

  test("discards an incomplete event after a complete frame", async () => {
    for (const suffix of ["", "\n"]) {
      const frames: SseFrame[] = [];
      const result = await consumeSse(
        chunkedResponse([
          bytes(
            `event: a\ndata: 1\n\nevent: b\ndata: partial${suffix}`,
          ),
        ]),
        {
          maxBytes: 10_000,
          maxEvents: 10,
          onEvent: (frame) => {
            frames.push(frame);
          },
        },
      );

      expect(result.reason).toBe("eof");
      expect(frames).toEqual([{ event: "a", data: "1" }]);
    }
  });

  test("dispatches a frame completed by a lone CR blank line at EOF", async () => {
    const frames: SseFrame[] = [];
    const result = await consumeSse(
      chunkedResponse([bytes("event: x\rdata: tail\r\r")]),
      {
        maxBytes: 10_000,
        maxEvents: 10,
        onEvent: (frame) => {
          frames.push(frame);
        },
      },
    );

    expect(result.reason).toBe("eof");
    expect(frames).toEqual([{ event: "x", data: "tail" }]);
  });

  test("stops at maxEvents by callback and by parsed-frame count", async () => {
    const text = "event: heartbeat\ndata: {}\n\nevent: heartbeat\ndata: {}\n\nevent: heartbeat\ndata: {}\n\n";
    const seen: SseFrame[] = [];
    const result = await consumeSse(chunkedResponse([bytes(text)]), {
      maxBytes: 10_000,
      maxEvents: 2,
      onEvent: (frame) => {
        seen.push(frame);
      },
    });

    expect(result.reason).toBe("max_events");
    expect(seen).toHaveLength(2);
  });

  test("cancels the body when stopping early", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          bytes("event: heartbeat\ndata: {}\n\nevent: heartbeat\ndata: {}\n\n"),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await consumeSse(stream, {
      maxBytes: 10_000,
      maxEvents: 1,
      onEvent: () => undefined,
    });
    expect(result.reason).toBe("max_events");
    expect(cancelled).toBe(true);
  });

  test("cancels the body when a done frame stops observation", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          bytes(
            "event: done\ndata: {}\n\nevent: heartbeat\ndata: {}\n\n",
          ),
        );
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await consumeSse(stream, {
      maxBytes: 10_000,
      maxEvents: 10,
      onEvent: (frame) => frame.event !== "done",
    });
    expect(result.reason).toBe("stopped");
    expect(cancelled).toBe(true);
  });

  test("stops on a callback false without parsing the rest", async () => {
    const text = "event: done\ndata: {}\n\nevent: heartbeat\ndata: {}\n\n";
    let count = 0;
    const result = await consumeSse(chunkedResponse([bytes(text)]), {
      maxBytes: 10_000,
      maxEvents: 10,
      onEvent: () => {
        count += 1;
        return false;
      },
    });

    expect(result.reason).toBe("stopped");
    expect(count).toBe(1);
  });

  test("bounds raw bytes before decoding and cancels the body", async () => {
    const text = `event: heartbeat\ndata: ${"x".repeat(200)}\n\n`;
    let count = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(text));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await consumeSse(stream, {
      maxBytes: 20,
      maxEvents: 10,
      onEvent: () => {
        count += 1;
      },
    });

    expect(result.reason).toBe("max_bytes");
    expect(count).toBe(0);
    expect(cancelled).toBe(true);
  });

  test("abort drops a buffered partial frame and cancels once", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const frames: SseFrame[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          bytes("event: a\ndata: 1\n\nevent: b\ndata: partial"),
        );
        setTimeout(() => controller.abort(), 5);
      },
      cancel() {
        cancelled = true;
      },
    });

    try {
      await consumeSse(stream, {
        maxBytes: 10_000,
        maxEvents: 10,
        signal: controller.signal,
        onEvent: (frame) => {
          frames.push(frame);
        },
      });
      throw new Error("expected abort");
    } catch (error) {
      expect(error).toBeInstanceOf(CapyError);
      expect((error as CapyError).code).toBe("aborted");
    }
    expect(frames).toEqual([{ event: "a", data: "1" }]);
    expect(cancelled).toBe(true);
  });

  test("rejects an already-aborted signal before reading", async () => {
    const controller = new AbortController();
    controller.abort();
    try {
      await consumeSse(chunkedResponse([bytes("event: done\ndata: {}\n\n")]), {
        maxBytes: 10_000,
        maxEvents: 10,
        signal: controller.signal,
        onEvent: () => undefined,
      });
      throw new Error("expected abort");
    } catch (error) {
      expect(error).toBeInstanceOf(CapyError);
      expect((error as CapyError).code).toBe("aborted");
    }
  });
});
