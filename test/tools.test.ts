import { describe, expect, test } from "bun:test";
import * as entry from "../index.ts";
import { CapyError } from "../src/errors.ts";
import {
  TOOL_SCHEMAS,
  createCapyToolsPlugin,
  type ToolDefinition,
  type ToolRuntime,
} from "../src/tools.ts";
import {
  TEST_ENV,
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
const thread = { id: "jam_01ABC", projectId: "project_alpha", status: "idle" };
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

async function toolsFor(runtime: ToolRuntime): Promise<Record<string, ToolDefinition>> {
  const plugin = await createCapyToolsPlugin(runtime)();
  return plugin.tool;
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

function stubTools(stub: FetchStub, env: Record<string, string | undefined> = TEST_ENV) {
  return toolsFor({ fetchImpl: stub.fetchImpl, env });
}

describe("plugin entry and tool schemas", () => {
  test("the Magpie entry exports only the plugin function", async () => {
    expect(Object.keys(entry)).toEqual(["CapyTools"]);
    expect(typeof entry.CapyTools).toBe("function");
    const hooks = await entry.CapyTools();
    expect(Object.keys(hooks.tool).sort()).toEqual([
      "create_thread",
      "get_task",
      "get_thread",
      "interrupt_thread",
      "list_messages",
      "list_projects",
      "list_subagent_messages",
      "list_subagents",
      "list_task_messages",
      "list_tasks",
      "list_threads",
      "run_task",
      "send_message",
      "watch_task",
      "watch_thread",
    ]);
  });

  test("all tool schemas are closed JSON objects with documented capability names", () => {
    const expected = [
      "create_thread",
      "get_task",
      "get_thread",
      "interrupt_thread",
      "list_messages",
      "list_projects",
      "list_subagent_messages",
      "list_subagents",
      "list_task_messages",
      "list_tasks",
      "list_threads",
      "run_task",
      "send_message",
      "watch_task",
      "watch_thread",
    ];
    expect(Object.keys(TOOL_SCHEMAS).sort()).toEqual(expected);
    for (const name of expected) {
      const schema = TOOL_SCHEMAS[name as keyof typeof TOOL_SCHEMAS] as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(schema.additionalProperties).toBe(false);
      expect(name.length).toBeLessThanOrEqual(48);
    }
  });

  test("no tool exposes a credential, base URL, or arbitrary HTTP option", () => {
    const serialized = JSON.stringify(TOOL_SCHEMAS);
    for (const forbidden of ["apiKey", "baseUrl", "baseURL", "url", "headers", "fetch"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });

  test("write tools require confirm and caller-supplied idempotency where supported", () => {
    for (const name of ["create_thread", "send_message", "interrupt_thread", "run_task"] as const) {
      const schema = TOOL_SCHEMAS[name] as {
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.required).toContain("confirm");
      expect(schema.properties.confirm).toMatchObject({ type: "boolean" });
    }
    const create = TOOL_SCHEMAS.create_thread as { required: string[] };
    expect(create.required).toContain("requestId");
    const send = TOOL_SCHEMAS.send_message as { required: string[] };
    expect(send.required).toContain("clientKey");
  });
});

describe("read tools", () => {
  test("list_projects uses the environment key and preserves documented shape", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const tools = await stubTools(stub);
    const result = (await tools.list_projects!.execute({})) as { items: (typeof project)[] };

    expect(result.items[0]?.id).toBe("project_alpha");
    expect(requestHeaders(stub.calls[0]!).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
    expect(stub.calls[0]?.url.toString()).toBe("https://api.capy.ai/api/v1/projects");
  });

  test("list_threads, get_thread, and list_messages forward explicit ids and cursors", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname.endsWith("/messages")) {
        return jsonResponse({
          items: [],
          cursor: "01J00000000000000000000001",
          beforeCursor: null,
        });
      }
      if (url.pathname === "/api/v1/threads") {
        return jsonResponse({ items: [thread], cursor: "10:next" });
      }
      return jsonResponse(thread);
    });
    const tools = await stubTools(stub);

    const page = (await tools.list_threads!.execute({
      projectId: "project_alpha",
      limit: 10,
      cursor: "9:prev",
    })) as { cursor: string };
    expect(page.cursor).toBe("10:next");
    expect(stub.calls[0]?.url.searchParams.get("projectId")).toBe("project_alpha");
    expect(stub.calls[0]?.url.searchParams.get("limit")).toBe("10");
    expect(stub.calls[0]?.url.searchParams.get("cursor")).toBe("9:prev");

    const one = (await tools.get_thread!.execute({ threadId: "jam_01ABC" })) as { id: string };
    expect(one.id).toBe("jam_01ABC");

    const messages = (await tools.list_messages!.execute({
      threadId: "jam_01ABC",
      after: "01J00000000000000000000000",
      limit: 20,
    })) as { cursor: string; beforeCursor: null };
    expect(messages.cursor).toBe("01J00000000000000000000001");
    expect(messages.beforeCursor).toBeNull();
    expect(stub.calls[2]?.url.searchParams.get("after")).toBe("01J00000000000000000000000");
  });

  test("subagent tools forward documented ids and cursors", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname.endsWith("/subagents")) {
        return jsonResponse({ items: [subagent], cursor: "10:next" });
      }
      return jsonResponse({
        items: [{ id: "01J00000000000000000000000", source: "assistant", text: "done", createdAt: "now" }],
        cursor: null,
      });
    });
    const tools = await stubTools(stub);

    const subagents = (await tools.list_subagents!.execute({
      threadId: "jam_01ABC",
      after: "9:prev",
      limit: 10,
    })) as { items: (typeof subagent)[]; cursor: string };
    expect(subagents.items[0]?.subagentPath).toBe("1");
    expect(subagents.cursor).toBe("10:next");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/subagents");
    expect(stub.calls[0]?.url.searchParams.get("after")).toBe("9:prev");

    const messages = (await tools.list_subagent_messages!.execute({
      subagentId: "subagent_1",
      after: "01J00000000000000000000000",
      limit: 5,
    })) as { items: { text: string }[]; cursor: null };
    expect(messages.items[0]?.text).toBe("done");
    expect(messages.cursor).toBeNull();
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/subagents/subagent_1/messages");
    expect(stub.calls[1]?.url.searchParams.get("after")).toBe("01J00000000000000000000000");
  });

  test("uses the host-saved key when the environment key is absent", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const tools = await toolsFor({
      fetchImpl: stub.fetchImpl,
      env: {},
      hostApiKey: () => "capy_test_SYNTHETIC_HOST_KEY_1",
    });
    await tools.list_projects!.execute({});
    expect(requestHeaders(stub.calls[0]!).get("authorization")).toBe(
      "Bearer capy_test_SYNTHETIC_HOST_KEY_1",
    );
  });

  test("environment key takes precedence over the host-saved key", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [project] }));
    const tools = await toolsFor({
      fetchImpl: stub.fetchImpl,
      env: TEST_ENV,
      hostApiKey: () => "capy_test_SYNTHETIC_HOST_KEY_2",
    });
    await tools.list_projects!.execute({});
    expect(requestHeaders(stub.calls[0]!).get("authorization")).toBe(`Bearer ${TEST_KEY}`);
  });

  test("multiple host accounts fail closed before any request", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const tools = await toolsFor({
      fetchImpl: stub.fetchImpl,
      env: {},
      hostApiKey: () => null,
      hostApiKeyError: () => "检测到多个 Capy 宿主账号。请只保留一个或设置 CAPY_API_KEY。",
    });
    const error = await expectCode(tools.list_projects!.execute({}), "configuration");
    expect(error.message).toContain("多个 Capy 宿主账号");
    expect(stub.calls).toHaveLength(0);
  });

  test("watch_thread forwards bounded options and returns collected progress", async () => {
    const stream =
      "event: status\ndata: {\"status\":\"working\"}\n\n" +
      "event: done\ndata: {}\n\n";
    const stub = makeFetch(() => sseResponse(stream));
    const tools = await stubTools(stub);
    const result = (await tools.watch_thread!.execute({
      threadId: "jam_01ABC",
      cursor: "01J00000000000000000000000",
      maxSeconds: 5,
      maxEvents: 20,
    })) as { ended: string; status: string; complete: boolean };

    expect(result.ended).toBe("done");
    expect(result.status).toBe("working");
    expect(result.complete).toBe(true);
    expect(stub.calls[0]?.url.searchParams.get("after")).toBe("01J00000000000000000000000");
    expect(requestHeaders(stub.calls[0]!).get("accept")).toBe("text/event-stream");
    expect(stub.calls.length).toBe(1);
  });

  test("missing key is actionable and never causes a request", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const tools = await stubTools(stub, {});
    const error = await expectCode(tools.list_projects!.execute({}), "configuration");
    expect(error.message).toContain("配置 Capy 组织 API Key");
    expect(error.message).toContain("CAPY_API_KEY");
    await expectCode(tools.get_thread!.execute({ threadId: "../escape" }), "invalid_arguments");
    expect(stub.calls).toHaveLength(0);
  });

  test("unknown argument names are not reflected in errors", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const tools = await stubTools(stub);
    const error = await expectCode(
      tools.list_projects!.execute({ [TEST_KEY]: "synthetic-value" }),
      "invalid_arguments",
    );
    expect(error.message).not.toContain(TEST_KEY);
    expect(error.message).toContain("This tool takes no arguments.");
    expect(stub.calls).toHaveLength(0);
  });

  test("unknown, malformed, and empty arguments are refused before fetch", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const tools = await stubTools(stub);

    await expectCode(tools.list_projects!.execute({ baseUrl: "https://evil.example" }), "invalid_arguments");
    await expectCode(tools.get_thread!.execute({ threadId: "../etc/passwd" }), "invalid_arguments");
    await expectCode(tools.get_thread!.execute({ threadId: "   " }), "invalid_arguments");
    await expectCode(tools.list_threads!.execute({ projectId: "project_alpha", limit: "10" }), "invalid_arguments");
    await expectCode(tools.list_messages!.execute({ threadId: "jam_01ABC", after: "short" }), "invalid_arguments");
    await expectCode(tools.watch_thread!.execute({ threadId: "jam_01ABC", maxSeconds: 41 }), "invalid_arguments");
    await expectCode(tools.watch_thread!.execute({ threadId: "jam_01ABC", maxEvents: 501 }), "invalid_arguments");
    expect(stub.calls).toHaveLength(0);
  });

  test("a pre-aborted context cancels before fetch", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [] }));
    const tools = await stubTools(stub);
    const controller = new AbortController();
    controller.abort();
    await expectCode(tools.list_projects!.execute({}, { abort: controller.signal }), "aborted");
    expect(stub.calls).toHaveLength(0);
  });
});

describe("write guards and payloads", () => {
  test("writes are disabled by default before any network call", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const tools = await stubTools(stub, TEST_ENV);
    const error = await expectCode(
      tools.create_thread!.execute({
        requestId: "request-1",
        projectId: "project_alpha",
        message: "hello",
        confirm: true,
      }),
      "writes_disabled",
    );
    expect(error.message).toContain("CAPY_ALLOW_WRITES=true");
    expect(stub.calls).toHaveLength(0);
  });

  test("writes require case-exact CAPY_ALLOW_WRITES=true", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "TRUE" });
    await expectCode(
      tools.interrupt_thread!.execute({ threadId: "jam_01ABC", confirm: true }),
      "writes_disabled",
    );
    expect(stub.calls).toHaveLength(0);
  });

  test("the non-secret allowWrites option enables writes without an env flag", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const plugin = createCapyToolsPlugin({
      fetchImpl: stub.fetchImpl,
      env: TEST_ENV,
    });
    const tools = (await plugin(undefined, { allowWrites: true })).tool;
    await tools.create_thread!.execute({
      requestId: "request-option",
      projectId: "project_alpha",
      message: "hello",
      confirm: true,
    });
    expect(requestBody(stub.calls[0]!).requestId).toBe("request-option");
    expect(stub.calls).toHaveLength(1);
  });

  test("writes require confirm:true for each invocation", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });

    const confirmation = await expectCode(
      tools.create_thread!.execute({
        requestId: "request-1",
        projectId: "project_alpha",
        message: "hello",
        confirm: false,
      }),
      "confirmation_required",
    );
    expect(confirmation.message).toContain("caller assertion");
    await expectCode(
      tools.send_message!.execute({
        threadId: "jam_01ABC",
        text: "hello",
        clientKey: "key-1",
      }),
      "confirmation_required",
    );
    await expectCode(
      tools.interrupt_thread!.execute({ threadId: "jam_01ABC", confirm: "true" }),
      "confirmation_required",
    );
    expect(stub.calls).toHaveLength(0);
  });

  test("create_thread preserves the caller requestId and title", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });
    const result = (await tools.create_thread!.execute({
      requestId: "11111111-1111-4111-8111-111111111111",
      projectId: "project_alpha",
      message: "Fix the flaky test.",
      title: "Fix test",
      confirm: true,
    })) as { id: string };

    expect(result.id).toBe("jam_01ABC");
    expect(requestBody(stub.calls[0]!)).toEqual({
      requestId: "11111111-1111-4111-8111-111111111111",
      projectId: "project_alpha",
      message: "Fix the flaky test.",
      title: "Fix test",
    });
    expect(stub.calls).toHaveLength(1);
  });

  test("send_message preserves clientKey and delivery; interrupt sends no body", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ id: "01J00000000000000000000002", deduped: false }),
    );
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });

    await tools.send_message!.execute({
      threadId: "jam_01ABC",
      text: "Also update docs.",
      clientKey: "caller-key-1",
      delivery: "steer",
      confirm: true,
    });
    expect(requestBody(stub.calls[0]!)).toEqual({
      text: "Also update docs.",
      clientKey: "caller-key-1",
      delivery: "steer",
    });

    await tools.interrupt_thread!.execute({ threadId: "jam_01ABC", confirm: true });
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/interrupt");
    expect(stub.calls[1]?.init.body).toBeUndefined();
  });

  test("mutating failures are not retried and do not leak the key", async () => {
    const stub = makeFetch(() =>
      jsonResponse({ _tag: "capy/RateLimited", message: TEST_KEY }, 429, { "retry-after": "2" }),
    );
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });
    const error = await expectCode(
      tools.create_thread!.execute({
        requestId: "request-1",
        projectId: "project_alpha",
        message: "hello",
        confirm: true,
      }),
      "rate_limited",
    );
    expect(error.retryAfterSeconds).toBe(2);
    expect(stub.calls).toHaveLength(1);
  });
});


const modelSelection = {
  modelId: "capy-coder",
  reasoningMode: "high",
  modes: { fast: true },
};
const task = {
  id: "task_1",
  threadId: "jam_01ABC",
  parentId: "jam_01ABC",
  taskPath: "1",
  projectId: "project_alpha",
  title: null,
  status: "done",
  archived: false,
  usage: { llmCredits: 1, imageCredits: 0, vmCredits: 0, totalCredits: 1 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  lastActivityAt: null,
};

describe("model selection and task lifecycle tools", () => {
  test("create_thread and send_message forward the documented model object", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/threads") return jsonResponse(thread);
      return jsonResponse({ id: "01J00000000000000000000002", deduped: false });
    });
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });

    await tools.create_thread!.execute({
      requestId: "request-model",
      projectId: "project_alpha",
      message: "hello",
      model: modelSelection,
      confirm: true,
    });
    expect(requestBody(stub.calls[0]!).model).toEqual(modelSelection);

    await tools.send_message!.execute({
      threadId: "jam_01ABC",
      text: "next",
      clientKey: "key-model",
      model: modelSelection,
      confirm: true,
    });
    expect(requestBody(stub.calls[1]!).model).toEqual(modelSelection);
  });

  test("task reads use the documented task paths and preserve cursors", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/threads/jam_01ABC/tasks") {
        return jsonResponse({ items: [task], cursor: "20:next" });
      }
      if (url.pathname === "/api/v1/tasks/task_1/messages") {
        return jsonResponse({ items: [], cursor: "01J00000000000000000000001" });
      }
      return jsonResponse(task);
    });
    const tools = await stubTools(stub);

    const page = (await tools.list_tasks!.execute({ threadId: "jam_01ABC", limit: 10 })) as {
      cursor: string;
    };
    expect(page.cursor).toBe("20:next");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/tasks");
    expect(stub.calls[0]?.url.searchParams.get("limit")).toBe("10");

    const one = (await tools.get_task!.execute({ taskId: "task_1" })) as { id: string };
    expect(one.id).toBe("task_1");
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/tasks/task_1");

    await tools.list_task_messages!.execute({
      taskId: "task_1",
      after: "01J00000000000000000000001",
    });
    expect(stub.calls[2]?.url.pathname).toBe("/api/v1/tasks/task_1/messages");
    expect(stub.calls[2]?.url.searchParams.get("after")).toBe("01J00000000000000000000001");
  });

  test("watch_task observes the task stream without claiming completion at EOF", async () => {
    const stub = makeFetch((url) => {
      expect(url.pathname).toBe("/api/v1/tasks/task_1/stream");
      return sseResponse(
        'event: task\ndata: {"status":"working"}\n\n' +
          'event: transcript\nid: 01J00000000000000000000001\ndata: {"id":"m1","source":"assistant","text":"hi","createdAt":"2026-01-01T00:00:00.000Z"}\n\n',
      );
    });
    const tools = await stubTools(stub);
    const out = (await tools.watch_task!.execute({ taskId: "task_1", maxSeconds: 1 })) as {
      taskId: string;
      status: string;
      transcript: { id: string }[];
      ended: string;
      complete: boolean;
    };
    expect(out.taskId).toBe("task_1");
    expect(out.status).toBe("working");
    expect(out.transcript[0]?.id).toBe("m1");
    expect(out.ended).toBe("connection_closed");
    expect(out.complete).toBe(false);
  });

  test("run_task is an explicit create/list/watch proxy with an honest complete flag", async () => {
    const stub = makeFetch((url, init) => {
      if (init.method === "POST" && url.pathname === "/api/v1/threads") return jsonResponse(thread);
      if (url.pathname === "/api/v1/threads/jam_01ABC/tasks") {
        return jsonResponse({ items: [task], cursor: null });
      }
      if (url.pathname === "/api/v1/tasks/task_1/stream") {
        return sseResponse('event: done\ndata: {}\n\n');
      }
      return jsonResponse({ _tag: "capy/InvalidRequest" }, 400);
    });
    const tools = await stubTools(stub, { ...TEST_ENV, CAPY_ALLOW_WRITES: "true" });
    const out = (await tools.run_task!.execute({
      requestId: "request-run",
      projectId: "project_alpha",
      message: "do the task",
      model: modelSelection,
      waitSeconds: 1,
      confirm: true,
    })) as {
      thread: { id: string };
      tasks: { id: string; status: string }[];
      observation: { taskId: string; ended: string; complete: boolean };
      complete: boolean;
      taskPending: boolean;
    };

    expect(out.thread.id).toBe("jam_01ABC");
    expect(out.tasks[0]).toMatchObject({ id: "task_1", status: "done" });
    expect(out.observation).toMatchObject({ taskId: "task_1", ended: "done", complete: true });
    expect(out.complete).toBe(true);
    expect(out.taskPending).toBe(false);
    expect(requestBody(stub.calls[0]!).model).toEqual(modelSelection);
    expect(stub.calls.map((call) => call.url.pathname)).toEqual([
      "/api/v1/threads",
      "/api/v1/threads/jam_01ABC/tasks",
      "/api/v1/tasks/task_1/stream",
    ]);
  });

  test("run_task is write-gated before any network call", async () => {
    const stub = makeFetch(() => jsonResponse(thread));
    const tools = await stubTools(stub, TEST_ENV);
    await expectCode(
      tools.run_task!.execute({
        requestId: "request-run",
        projectId: "project_alpha",
        message: "do the task",
        confirm: true,
      }),
      "writes_disabled",
    );
    expect(stub.calls).toHaveLength(0);
  });
});
