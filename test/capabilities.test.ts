import { describe, expect, test } from "bun:test";
import { createCapyClient } from "../src/client.ts";
import { CapyError } from "../src/errors.ts";
import { TEST_KEY, jsonResponse, makeFetch, requestBody, sseResponse } from "./helpers.ts";

const catalog = {
  items: [
    {
      id: "capy-coder",
      name: "Capy Coder",
      billing: "Capy API",
      route: "capy",
      reasoningModes: ["low", "high"],
      fast: false,
      pro: true,
      ultrafast: false,
    },
  ],
  default: { modelId: "capy-coder", source: "personal", skipped: [] },
};
const balance = {
  currency: "USD",
  remainingDollars: 4.25,
  unlimited: false,
  periodStart: "2026-11-01T00:00:00.000Z",
  periodEnd: "2026-12-01T00:00:00.000Z",
};
const report = {
  from: balance.periodStart,
  to: balance.periodEnd,
  totals: {
    llmDollars: 1,
    imageDollars: 0,
    vmDollars: 0,
    totalDollars: 1,
    standaloneTokenFeeDollars: 0,
    billedDollars: 1,
  },
  tokens: {
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  members: [],
  models: [],
  images: [],
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

async function expectCode(promise: Promise<unknown>, code: CapyError["code"]): Promise<void> {
  try {
    await promise;
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CapyError);
    expect((error as CapyError).code).toBe(code);
  }
}

describe("Capy model and usage reads", () => {
  test("listModels uses GET /api/v1/models and preserves documented fields", async () => {
    const stub = makeFetch(() => jsonResponse(catalog));
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });
    const out = await client.listModels();
    expect(out.items[0]).toMatchObject({
      id: "capy-coder",
      route: "capy",
      reasoningModes: ["low", "high"],
    });
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/models");
    expect(stub.calls[0]?.init.method).toBe("GET");
  });

  test("listModels rejects an incomplete catalog instead of inventing fields", async () => {
    const stub = makeFetch(() => jsonResponse({ items: [{ id: "missing-name" }], default: catalog.default }));
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });
    await expectCode(client.listModels(), "invalid_response");
  });

  test("getUsageBalance carries numeric, null, unlimited, and special values", async () => {
    const numeric = makeFetch(() => jsonResponse(balance));
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: numeric.fetchImpl });
    expect((await client.getUsageBalance()).remainingDollars).toBe(4.25);

    const unlimited = makeFetch(() =>
      jsonResponse({ ...balance, remainingDollars: null, unlimited: true }),
    );
    const unlimitedClient = createCapyClient({ apiKey: TEST_KEY, fetchImpl: unlimited.fetchImpl });
    expect((await unlimitedClient.getUsageBalance()).unlimited).toBe(true);

    const special = makeFetch(() =>
      jsonResponse({ ...balance, remainingDollars: "Infinity" }),
    );
    const specialClient = createCapyClient({ apiKey: TEST_KEY, fetchImpl: special.fetchImpl });
    expect((await specialClient.getUsageBalance()).remainingDollars).toBe("Infinity");
  });

  test("getUsageBalance rejects a non-USD currency or a missing field", async () => {
    const eur = makeFetch(() => jsonResponse({ ...balance, currency: "EUR" }));
    await expectCode(
      createCapyClient({ apiKey: TEST_KEY, fetchImpl: eur.fetchImpl }).getUsageBalance(),
      "invalid_response",
    );
    const missing = makeFetch(() => jsonResponse({ currency: "USD", unlimited: false }));
    await expectCode(
      createCapyClient({ apiKey: TEST_KEY, fetchImpl: missing.fetchImpl }).getUsageBalance(),
      "invalid_response",
    );
  });

  test("getUsageReport sends from/to and validates the documented totals", async () => {
    const stub = makeFetch(() => jsonResponse(report));
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });
    const out = await client.getUsageReport({ from: balance.periodStart, to: balance.periodEnd });
    expect(out.totals.totalDollars).toBe(1);
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/usage");
    expect(stub.calls[0]?.url.searchParams.get("from")).toBe(balance.periodStart);
    expect(stub.calls[0]?.url.searchParams.get("to")).toBe(balance.periodEnd);
  });
});

describe("Capy task reads and selection", () => {
  test("task reads use documented paths, ids, and cursors", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname.endsWith("/tasks")) return jsonResponse({ items: [task], cursor: "20:next" });
      if (url.pathname.endsWith("/messages")) return jsonResponse({ items: [], cursor: null });
      return jsonResponse(task);
    });
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });

    expect((await client.listTasks("jam_01ABC", { after: "10:a", limit: 5 })).cursor).toBe("20:next");
    expect(stub.calls[0]?.url.pathname).toBe("/api/v1/threads/jam_01ABC/tasks");
    expect(stub.calls[0]?.url.searchParams.get("after")).toBe("10:a");
    expect(stub.calls[0]?.url.searchParams.get("limit")).toBe("5");

    expect((await client.getTask("task_1")).status).toBe("done");
    expect(stub.calls[1]?.url.pathname).toBe("/api/v1/tasks/task_1");

    await client.listTaskMessages("task_1", { after: "01J00000000000000000000001" });
    expect(stub.calls[2]?.url.pathname).toBe("/api/v1/tasks/task_1/messages");
  });

  test("createThread and sendMessage place model selection under the documented model field", async () => {
    const stub = makeFetch((url) => {
      if (url.pathname === "/api/v1/threads") return jsonResponse({ id: "jam_01ABC" });
      return jsonResponse({ id: "01J00000000000000000000002", deduped: false });
    });
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });
    const model = { modelId: "capy-coder", reasoningMode: "high" as const, modes: { fast: true } };

    await client.createThread({
      requestId: "request-1",
      projectId: "project_alpha",
      message: "hello",
      model,
    });
    expect(requestBody(stub.calls[0]!).model).toEqual(model);

    await client.sendMessage("jam_01ABC", { text: "next", clientKey: "key-1", model });
    expect(requestBody(stub.calls[1]!).model).toEqual(model);
  });

  test("invalid model selection is rejected before fetch", async () => {
    const stub = makeFetch(() => jsonResponse({ id: "jam_01ABC" }));
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: stub.fetchImpl });
    await expectCode(
      client.createThread({
        requestId: "request-1",
        projectId: "project_alpha",
        message: "hello",
        model: { modelId: "capy-coder", unexpected: true } as never,
      }),
      "invalid_arguments",
    );
    expect(stub.calls).toHaveLength(0);
  });

  test("watchTask uses the task stream and marks done only on its own done frame", async () => {
    const done = makeFetch(() =>
      sseResponse('event: task\ndata: {"status":"working"}\n\nevent: done\ndata: {}\n\n'),
    );
    const client = createCapyClient({ apiKey: TEST_KEY, fetchImpl: done.fetchImpl });
    const out = await client.watchTask("task_1", { maxSeconds: 1 });
    expect(out.taskId).toBe("task_1");
    expect(out.subjectId).toBe("task_1");
    expect(out.status).toBe("working");
    expect(out.ended).toBe("done");
    expect(out.complete).toBe(true);
    expect(done.calls[0]?.url.pathname).toBe("/api/v1/tasks/task_1/stream");

    const eof = makeFetch(() => sseResponse('event: task\ndata: {"status":"working"}\n\n'));
    const eofClient = createCapyClient({ apiKey: TEST_KEY, fetchImpl: eof.fetchImpl });
    const partial = await eofClient.watchTask("task_1", { maxSeconds: 1 });
    expect(partial.ended).toBe("connection_closed");
    expect(partial.complete).toBe(false);
  });
});
