import { describe, expect, test } from "bun:test";
import { createCapyClient, type CapyClientOptions } from "../src/client.ts";
import { CapyError } from "../src/errors.ts";
import {
  TEST_KEY,
  jsonResponse,
  makeFetch,
  requestBody,
  requestHeaders,
  sseResponse,
  type FetchStub,
} from "./helpers.ts";

const project = {
  id: "project_alpha",
  name: "Alpha",
  description: null,
  code: "ALPHA",
  visibility: "org",
  repos: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const thread = {
  id: "jam_01ABC",
  projectId: "project_alpha",
  status: "idle",
};
const message = {
  id: "01J00000000000000000000000",
  source: "assistant",
  text: "hello",
  createdAt: "2026-01-01T00:00:00.000Z",
};
const subagent = {
  id: "subagent_1",
  threadId: "jam_01ABC",
  parentId: "jam_01ABC",
  subagentPath: "1",
  taskPath: "1",
  projectId: "project_alpha",
  title: null,
  status: "working",
  archived: false,
  usage: { llmCredits: 0, imageCredits: 0, vmCredits: 0, totalCredits: 0 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: null,
};

function client(stub: FetchStub, overrides: Partial<CapyClientOptions> = {}) {
  return createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl, ...overrides });
}

async function expectCode(promise: Promise<unknown>, code: CapyError["code"]): Promise<CapyError> {
  try {
    await promise;
    throw new Error(`expected CapyError ${code}, but the call succeeded`);
  } catch (error) {
    expect(error).toBeInstanceOf(CapyError);
    const capy = error as CapyError;
    expect(capy.code).toBe(code);
    expect(capy.message).not.toContain(TEST_KEY);
    return capy;
  }
}

describe("CapyClient reads", () => {
  test("lists projects with a fixed origin and bearer auth", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const result = await client(stub).listProjects();

    expect(result.items[0]?.id).toBe("project_alpha");
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.url.toString()).toBe("https://api.capy.ai/api/v1/projects");
    expect(stub.calls[0]?.init.method).toBe("GET");
    expect(requestHeaders(stub.calls[0]!).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(requestHeaders(stub.calls[0]!).get("accept")).toBe("application/json");
    expect(stub.calls[0]?.init.redirect).toBe("manual");
    expect(stub.calls[0]?.url.toString()).not.toContain(TEST_KEY);
  });

  test("lists threads with project paging and returns the cursor unchanged", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ items: [thread], cursor: "12:opaque-next" }),
    );
    const result = await client(stub).listThreads({
      projectId: "project_alpha",
      limit: 25,
      cursor: "9:opaque-prev",
    });

    expect(result.cursor).toBe("12:opaque-next");
    const url = stub.calls[0]!.url;
    expect(url.pathname).toBe("/api/v1/threads");
    expect(url.searchParams.get("projectId")).toBe("project_alpha");
    expect(url.searchParams.get("limit")).toBe("25");
    expect(url.searchParams.get("cursor")).toBe("9:opaque-prev");
  });

  test("lists subagents and subagent messages with forward cursors", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname.endsWith("/subagents")) {
        return jsonResponse({ items: [subagent], cursor: "12:next" });
      }
      return jsonResponse({
        items: [message],
        cursor: "01J00000000000000000000001",
      });
    });
    const instance = client(stub);

    const subagents = await instance.listSubagents("jam_01ABC", {
      after: "9:prev",
      limit: 20,
    });
    expect(subagents.items[0]?.taskPath).toBe("1");
    expect(subagents.cursor).toBe("12:next");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/subagents");
    expect(stub.calls[0]?.url.searchParams.get("after")).toBe("9:prev");
    expect(stub.calls[0]?.url.searchParams.get("limit")).toBe("20");

    const messages = await instance.listSubagentMessages("subagent_1", {
      after: "01J00000000000000000000000",
      limit: 10,
    });
    expect(messages.items[0]?.text).toBe("hello");
    expect(messages.cursor).toBe("01J00000000000000000000001");
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/subagents/subagent_1/messages");
    expect(stub.calls[1]?.url.searchParams.get("after")).toBe("01J00000000000000000000000");
    expect(stub.calls[1]?.url.searchParams.get("limit")).toBe("10");
  });

  test("gets one thread", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const result = await client(stub).getThread("jam_01ABC");
    expect(result.id).toBe("jam_01ABC");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC");
  });

  test("accepts an empty transcript text value", async () => {
    const stub = makeFetch(() =>
      jsonResponse({
        items: [{ ...message, text: "" }],
        cursor: null,
        beforeCursor: null,
      }),
    );
    const result = await client(stub).listMessages("jam_01ABC");
    expect(result.items[0]?.text).toBe("");
  });

  test("lists messages with after/before cursors and preserves both page cursors", async () => {
    const stub = makeFetch(() =>
      jsonResponse({
        items: [message],
        cursor: "01J00000000000000000000001",
        beforeCursor: "01J00000000000000000000000",
      }),
    );
    const result = await client(stub).listMessages("jam_01ABC", {
      after: "01J00000000000000000000000",
      before: "01J00000000000000000000009",
      limit: 50,
    });

    expect(result.cursor).toBe("01J00000000000000000000001");
    expect(result.beforeCursor).toBe("01J00000000000000000000000");
    const url = stub.calls[0]!.url;
    expect(url.pathname).toBe("/api/v1/threads/jam_01ABC/messages");
    expect(url.searchParams.get("after")).toBe("01J00000000000000000000000");
    expect(url.searchParams.get("before")).toBe("01J00000000000000000000009");
    expect(url.searchParams.get("limit")).toBe("50");
  });
});

describe("CapyClient writes", () => {
  test("creates a thread using the exact caller requestId and no generated retry", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const instance = client(stub);

    await instance.createThread({
      requestId: "caller-request-123",
      projectId: "project_alpha",
      message: "Fix the test.",
      title: "A title",
    });
    await instance.createThread({
      requestId: "caller-request-123",
      projectId: "project_alpha",
      message: "Fix the test.",
      title: "A title",
    });

    expect(stub.calls).toHaveLength(2);
    expect(requestBody(stub.calls[0]!)).toEqual({
      requestId: "caller-request-123",
      projectId: "project_alpha",
      message: "Fix the test.",
      title: "A title",
    });
    expect(requestBody(stub.calls[1]!)).toEqual(requestBody(stub.calls[0]!));
    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(requestHeaders(stub.calls[0]!).get("content-type")).toBe("application/json");
    expect(JSON.stringify(requestBody(stub.calls[0]!))).not.toContain(TEST_KEY);
  });

  test("sends a message with clientKey and explicit delivery", async () => {
    const stub = makeFetch(() => jsonResponse({ id: "01J00000000000000000000002", deduped: false }));
    const result = await client(stub).sendMessage("jam_01ABC", {
      text: "Also update the changelog.",
      clientKey: "caller-client-key",
      delivery: "queue",
    });

    expect(result).toEqual({ id: "01J00000000000000000000002", deduped: false });
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/message");
    expect(requestBody(stub.calls[0]!)).toEqual({
      text: "Also update the changelog.",
      clientKey: "caller-client-key",
      delivery: "queue",
    });
  });

  test("interrupts a thread without inventing a body or retrying", async () => {
    const stub = makeFetch(() => jsonResponse({ id: "01J00000000000000000000003", deduped: false }));
    const result = await client(stub).interruptThread("jam_01ABC");

    expect(result.deduped).toBe(false);
    expect(stub.calls[0]?.init.method).toBe("POST");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/interrupt");
    expect(stub.calls[0]?.init.body).toBeUndefined();
    expect(requestHeaders(stub.calls[0]!).get("content-type")).toBeNull();
    expect(stub.calls).toHaveLength(1);
  });
});

describe("CapyClient validation", () => {
  test("rejects malformed ids, empty text, excessive text, and invalid options before fetch", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const instance = client(stub);

    await expectCode(instance.getThread("../etc/passwd"), "invalid_arguments");
    await expectCode(instance.getThread("a/b"), "invalid_arguments");
    await expectCode(instance.getThread("   "), "invalid_arguments");
    await expectCode(instance.listThreads({ projectId: "project_alpha", limit: 0 }), "invalid_arguments");
    await expectCode(instance.listThreads({ projectId: "project_alpha", cursor: "bad\ncursor" }), "invalid_arguments");
    await expectCode(instance.listMessages("jam_01ABC", { after: "short" }), "invalid_arguments");
    await expectCode(instance.listSubagentMessages("../escape"), "invalid_arguments");
    await expectCode(instance.listSubagents("jam_01ABC", { after: "bad cursor" }), "invalid_arguments");
    await expectCode(
      instance.createThread({
        requestId: "req with spaces",
        projectId: "project_alpha",
        message: "ok",
      }),
      "invalid_arguments",
    );
    await expectCode(
      instance.createThread({
        requestId: "req",
        projectId: "project_alpha",
        message: "   ",
      }),
      "invalid_arguments",
    );
    await expectCode(
      instance.createThread({
        requestId: "req",
        projectId: "project_alpha",
        message: "x".repeat(100_001),
      }),
      "invalid_arguments",
    );
    await expectCode(
      instance.sendMessage("jam_01ABC", { text: "", clientKey: "key" }),
      "invalid_arguments",
    );
    await expectCode(
      instance.sendMessage("jam_01ABC", { text: "hello", clientKey: "bad key" }),
      "invalid_arguments",
    );
    expect(stub.calls).toHaveLength(0);
  });

  test("rejects an empty API key with an actionable configuration error", () => {
    expect(() => createCapyClient({ apiKey: "  " })).toThrow(CapyError);
    try {
      createCapyClient({ apiKey: "  " });
    } catch (error) {
      expect((error as CapyError).code).toBe("configuration");
      expect((error as CapyError).message).toContain("Capy Settings > API");
    }
  });
});

describe("CapyClient failures", () => {
  test("maps 401 without echoing upstream text", async () => {
    const stub = makeFetch(() =>
      jsonResponse(
        { _tag: "capy/Unauthorized", message: `SECRET upstream ${TEST_KEY}` },
        401,
      ),
    );
    const error = await expectCode(client(stub).listProjects(), "unauthorized");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).not.toContain("upstream");
  });

  test("maps 403 and 404 known tags", async () => {
    const forbidden = makeFetch(() => jsonResponse({ _tag: "capy/Forbidden" }, 403));
    const forbiddenError = await expectCode(client(forbidden).listProjects(), "forbidden");
    expect(forbiddenError.status).toBe(403);

    const missing = makeFetch(() => jsonResponse({ _tag: "capy/ProjectNotFound" }, 404));
    const missingError = await expectCode(
      client(missing).listThreads({ projectId: "project_alpha" }),
      "not_found",
    );
    expect(missingError.message).toContain("capy/ProjectNotFound");

    const missingSubagent = makeFetch(() =>
      jsonResponse({ _tag: "capy/SubagentNotFound" }, 404),
    );
    const subagentError = await expectCode(
      client(missingSubagent).listSubagentMessages("subagent_1"),
      "not_found",
    );
    expect(subagentError.message).toContain("capy/SubagentNotFound");
  });

  test("maps 429 retry-after from headers and makes no retry", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ _tag: "capy/RateLimited", retryAfterSeconds: 4 }, 429, {
        "retry-after": "7",
      }),
    );
    const error = await expectCode(client(stub).listProjects(), "rate_limited");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(7);
    expect(error.message).toContain("7 seconds");
    expect(stub.calls).toHaveLength(1);
  });

  test("falls back to body retryAfterSeconds when the header is absent", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ _tag: "capy/RateLimited", retryAfterSeconds: 3 }, 429),
    );
    const error = await expectCode(client(stub).listProjects(), "rate_limited");
    expect(error.retryAfterSeconds).toBe(3);
    expect(error.message).toContain("3 seconds");
  });

  test("maps 5xx without upstream text", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ _tag: "Secret.Internal", message: "database password" }, 500),
    );
    const error = await expectCode(client(stub).listProjects(), "server_error");
    expect(error.status).toBe(500);
    expect(error.message).not.toContain("database");
    expect(error.message).not.toContain("Secret.Internal");
  });

  test("maps invalid success JSON and invalid response shapes", async () => {
    const badJson = makeFetch(() => new Response("not json", { status: 200 }));
    await expectCode(client(badJson).listProjects(), "invalid_response");

    const badShape = makeFetch(() => jsonResponse({ items: [{ id: "x" }] }));
    await expectCode(client(badShape).listProjects(), "invalid_response");

    const badMessage = makeFetch(() =>
      jsonResponse({ items: [{ id: "x", source: "system", text: "", createdAt: "now" }], cursor: null, beforeCursor: null }),
    );
    await expectCode(client(badMessage).listMessages("jam_01ABC"), "invalid_response");

    const badSubagent = makeFetch(() =>
      jsonResponse({ items: [{ ...subagent, threadId: undefined }], cursor: null }),
    );
    await expectCode(client(badSubagent).listSubagents("jam_01ABC"), "invalid_response");
  });

  test("refuses redirects, cancels their body, and never follows them", async () => {
    let cancelled = false;
    const stub = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 302, headers: { location: "https://evil.example/steal" } },
        ),
    );
    const error = await expectCode(client(stub).listProjects(), "redirect_refused");
    expect(error.message).not.toContain("evil.example");
    expect(stub.calls).toHaveLength(1);
    expect(cancelled).toBe(true);
  });

  test("maps network failures generically", async () => {
    const stub = makeFetch(() => {
      throw new Error(`network blew up with ${TEST_KEY}`);
    });
    const error = await expectCode(client(stub).listProjects(), "network_error");
    expect(error.message).not.toContain(TEST_KEY);
    expect(error.message).not.toContain("blew up");
  });

  test("times out and aborts the request without retrying", async () => {
    const stub = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const error = await expectCode(client(stub, { timeoutMs: 10 }).listProjects(), "timeout");
    expect(error.message).toContain("timed out");
    expect(stub.calls).toHaveLength(1);
  });

  test("rejects an already-aborted signal before fetch", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const controller = new AbortController();
    controller.abort();
    await expectCode(client(stub).listProjects({ signal: controller.signal }), "aborted");
    expect(stub.calls).toHaveLength(0);
  });

  test("cancels an in-flight request when the caller aborts", async () => {
    const controller = new AbortController();
    const stub = makeFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
          setTimeout(() => controller.abort(), 5);
        }),
    );
    await expectCode(
      client(stub).listProjects({ signal: controller.signal }),
      "aborted",
    );
    expect(stub.calls).toHaveLength(1);
  });

  test("bounds successful response bodies", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ items: [{ id: "x", name: "y".repeat(5_000) }] }),
    );
    const error = await expectCode(
      client(stub, { maxResponseBytes: 1_024 }).listProjects(),
      "response_too_large",
    );
    expect(error.message).toContain("1024");
  });

  test("does not retry a mutating 429", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/RateLimited" }, 429, { "retry-after": "1" }));
    await expectCode(
      client(stub).createThread({
        requestId: "request-1",
        projectId: "project_alpha",
        message: "hello",
      }),
      "rate_limited",
    );
    expect(stub.calls).toHaveLength(1);
  });
});

describe("CapyClient watch_thread", () => {
  test("collects bounded progress, split UTF-8, CRLF, previews, and committed transcript", async () => {
    const stream =
      "event: status\r\ndata: {\"threadId\":\"jam_01ABC\",\"status\":\"working\"}\r\n\r\n" +
      "retry: 2000\r\n\r\n" +
      "event: run\r\ndata: {\"phase\":\"start\"}\r\n\r\n" +
      "event: assistant\r\ndata: {\"callId\":\"c1\",\"text\":\"你好\"}\r\n\r\n" +
      "event: assistant\r\ndata: {\"callId\":\"c1\",\"text\":\" \ud83e\udda9\"}\r\n\r\n" +
      "event: tool_call\r\ndata: {\"callId\":\"t1\",\"name\":\"bash\",\"text\":\"Running tests\"}\r\n\r\n" +
      "event: heartbeat\r\ndata: {}\r\n\r\n" +
      "event: future_event\r\ndata: {\"x\":1}\r\n\r\n" +
      "id: 01J00000000000000000000001\r\n" +
      "event: transcript\r\ndata: {\"id\":\"01J00000000000000000000001\",\"source\":\"assistant\",\"callId\":\"c1\",\"text\":\"你好 🦩\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\r\n\r\n" +
      "event: done\r\ndata: {}\r\n\r\n";
    const encoder = new TextEncoder();
    const emojiByteIndex = encoder.encode(stream.slice(0, stream.indexOf("🦩"))).length;
    const split = emojiByteIndex + 2;
    const stub = makeFetch(() => sseResponse(stream, [split]));

    const summary = await client(stub).watchThread("jam_01ABC", {
      cursor: "01J00000000000000000000000",
      maxSeconds: 10,
      maxEvents: 100,
    });

    expect(stub.calls[0]?.url.searchParams.get("after")).toBe("01J00000000000000000000000");
    expect(requestHeaders(stub.calls[0]!).get("accept")).toBe("text/event-stream");
    expect(summary.complete).toBe(true);
    expect(summary.ended).toBe("done");
    expect(summary.status).toBe("working");
    expect(summary.lastEventId).toBe("01J00000000000000000000001");
    expect(summary.runs).toEqual({ started: 1, ended: 0 });
    expect(summary.counts.transcript).toBe(1);
    expect(summary.counts.assistant).toBe(2);
    expect(summary.counts.toolCall).toBe(1);
    expect(summary.counts.heartbeat).toBe(1);
    expect(summary.counts.unknown).toBe(1);
    expect(summary.transcript[0]?.text).toBe("你好 🦩");
    expect(summary.previews.assistant).toEqual([]);
    expect(summary.previews.toolCalls[0]?.name).toBe("bash");
  });

  test("discards uncommitted assistant and tool previews at run end", async () => {
    const stream =
      "event: assistant\ndata: {\"callId\":\"discard-me\",\"text\":\"uncommitted\"}\n\n" +
      "event: tool_call\ndata: {\"callId\":\"discard-tool\",\"name\":\"bash\",\"text\":\"Running\"}\n\n" +
      "event: run\ndata: {\"phase\":\"end\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.ended).toBe("done");
    expect(summary.transcript).toEqual([]);
    expect(summary.previews.assistant).toEqual([]);
    expect(summary.previews.toolCalls).toEqual([]);
    expect(summary.lastEventId).toBeNull();
  });

  test("replaces committed assistant previews with the transcript entry", async () => {
    const frameCursor = "01J00000000000000000000011";
    const stream =
      "event: assistant\ndata: {\"callId\":\"c1\",\"text\":\"Tests pass. \"}\n\n" +
      "event: assistant\ndata: {\"callId\":\"c1\",\"text\":\"PR is up.\"}\n\n" +
      `id: ${frameCursor}\n` +
      "event: transcript\ndata: {\"id\":\"message-1\",\"source\":\"assistant\",\"callId\":\"c1\",\"text\":\"Tests pass. PR is up.\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.transcript[0]?.text).toBe("Tests pass. PR is up.");
    expect(summary.previews.assistant).toEqual([]);
    expect(summary.lastEventId).toBe(frameCursor);
  });

  test("removes a live tool call when its committed transcript arrives", async () => {
    const frameCursor = "01J00000000000000000000012";
    const stream =
      "event: tool_call\ndata: {\"callId\":\"toolu_1\",\"name\":\"bash\",\"text\":\"Running tests\"}\n\n" +
      `id: ${frameCursor}\n` +
      "event: transcript\ndata: {\"id\":\"toolu_1\",\"source\":\"tool\",\"tool\":\"bash\",\"text\":\"Running tests\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.previews.toolCalls).toEqual([]);
    expect(summary.transcript[0]?.source).toBe("tool");
    expect(summary.transcript[0]?.text).toBe("Running tests");
    expect(summary.lastEventId).toBe(frameCursor);
  });

  test("discards previews when a turn is dropped", async () => {
    const stream =
      "event: assistant\ndata: {\"callId\":\"partial\",\"text\":\"untrusted partial\"}\n\n" +
      "event: turn\ndata: {\"phase\":\"end\",\"outcome\":\"dropped\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.turns.lastOutcome).toBe("dropped");
    expect(summary.previews.assistant).toEqual([]);
    expect(summary.transcript).toEqual([]);
  });

  test("advances lastEventId only for valid committed transcript frames", async () => {
    const unknownCursor = "01J00000000000000000000021";
    const malformedCursor = "01J00000000000000000000022";
    const committedCursor = "01J00000000000000000000023";
    const stream =
      `id: ${unknownCursor}\n` +
      "event: future_event\ndata: {\"x\":1}\n\n" +
      `id: ${malformedCursor}\n` +
      "event: transcript\ndata: {}\n\n" +
      "id: short\n" +
      "event: transcript\ndata: {\"id\":\"message-2\",\"source\":\"assistant\",\"text\":\"\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\n\n" +
      `id: ${committedCursor}\n` +
      "event: transcript\ndata: {\"id\":\"message-3\",\"source\":\"assistant\",\"text\":\"committed\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.lastEventId).toBe(committedCursor);
    expect(summary.transcript.map((entry) => entry.id)).toEqual(["message-2", "message-3"]);
    expect(summary.transcript[0]?.text).toBe("");
    expect(summary.counts.malformed).toBe(1);
    expect(summary.counts.unknown).toBe(1);
  });

  test("keeps complete transcript frames and their cursor when EOF truncates the next event", async () => {
    const completeCursor = "01J00000000000000000000031";
    const incompleteCursor = "01J00000000000000000000032";
    const stream =
      `id: ${completeCursor}\n` +
      "event: transcript\ndata: {\"id\":\"message-1\",\"source\":\"assistant\",\"text\":\"complete\",\"createdAt\":\"2026-01-01T00:00:00.000Z\"}\n\n" +
      `id: ${incompleteCursor}\n` +
      "event: transcript\ndata: {\"id\":\"message-2\",\"source\":\"assistant\",\"text\":\"incomplete";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });

    expect(summary.ended).toBe("connection_closed");
    expect(summary.transcript.map((entry) => entry.id)).toEqual(["message-1"]);
    expect(summary.lastEventId).toBe(completeCursor);
  });

  test("returns bounded max_events and cancels the body", async () => {
    const stream =
      "event: status\ndata: {\"threadId\":\"jam_01ABC\",\"status\":\"working\"}\n\n" +
      "event: heartbeat\ndata: {}\n\n" +
      "event: heartbeat\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", {
      maxSeconds: 10,
      maxEvents: 2,
    });
    expect(summary.complete).toBe(false);
    expect(summary.ended).toBe("max_events");
    expect(summary.counts.status + summary.counts.heartbeat).toBe(2);
  });

  test("returns max_bytes for oversized streams", async () => {
    const stream = `event: heartbeat\ndata: ${"x".repeat(1_100_000)}\n\n`;
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });
    expect(summary.ended).toBe("max_bytes");
    expect(summary.complete).toBe(false);
  });

  test("reports remote error frames with safe allowlisted messages", async () => {
    const stream =
      "event: error\ndata: {\"code\":\"unauthorized\",\"message\":\"SECRET upstream text\"}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 10 });
    expect(summary.ended).toBe("remote_error");
    expect(summary.remoteError?.code).toBe("unauthorized");
    expect(summary.remoteError?.message).not.toContain("SECRET");
  });

  test("returns a partial result at the local time limit", async () => {
    const stream = "event: status\ndata: {\"threadId\":\"jam_01ABC\",\"status\":\"working\"}\n\n";
    const stub = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(stream));
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    const summary = await client(stub).watchThread("jam_01ABC", { maxSeconds: 1 });
    expect(summary.ended).toBe("time_limit");
    expect(summary.status).toBe("working");
    expect(summary.complete).toBe(false);
  });

  test("throws a safe aborted error and cancels local observation", async () => {
    const controller = new AbortController();
    const stub = makeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(streamController) {
              streamController.enqueue(
                new TextEncoder().encode("event: status\ndata: {\"status\":\"working\"}\n\n"),
              );
              setTimeout(() => controller.abort(), 5);
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );
    await expectCode(
      client(stub).watchThread("jam_01ABC", {
        maxSeconds: 10,
        signal: controller.signal,
      }),
      "aborted",
    );
  });

  test("maps pre-stream watch error responses with retry metadata", async () => {
    const stub = makeFetch(() => jsonResponse({ _tag: "capy/RateLimited" }, 429, { "retry-after": "5" }));
    const error = await expectCode(
      client(stub).watchThread("jam_01ABC", { maxSeconds: 10 }),
      "rate_limited",
    );
    expect(error.retryAfterSeconds).toBe(5);
    expect(stub.calls).toHaveLength(1);
  });

  test("rejects invalid watch bounds before fetch", async () => {
    const stub = makeFetch(() => sseResponse(""));
    const instance = client(stub);
    await expectCode(instance.watchThread("jam_01ABC", { maxSeconds: 41 }), "invalid_arguments");
    await expectCode(instance.watchThread("jam_01ABC", { maxEvents: 0 }), "invalid_arguments");
    await expectCode(instance.watchThread("jam_01ABC", { cursor: "bad cursor" }), "invalid_arguments");
    expect(stub.calls).toHaveLength(0);
  });
});
