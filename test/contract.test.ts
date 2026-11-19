import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { CAPY_API_ORIGIN, ENDPOINTS } from "../src/endpoints.ts";
import { TOOL_SCHEMAS } from "../src/tools.ts";

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema: Record<string, unknown>;
}

interface Operation {
  method: string;
  path: string;
  operationId: string;
  parameters: Parameter[];
  request: null | {
    required: boolean;
    fields: string[];
    requiredFields: string[];
  };
  response200: Record<string, unknown> | null;
  errorTags: { status: string; description: string; headers: Record<string, unknown> }[];
}

interface Fixture {
  source: string;
  openapi: string;
  title: string;
  version: string;
  server: string;
  operations: Record<string, Operation>;
  schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/capy-openapi-subset.json", import.meta.url), "utf8"),
) as Fixture;

type ObjectSchema = {
  properties: Record<string, Record<string, unknown>>;
  required: string[];
  additionalProperties?: boolean;
};

function schema(name: keyof typeof TOOL_SCHEMAS): ObjectSchema {
  return TOOL_SCHEMAS[name] as ObjectSchema;
}

function paramsFor(operation: Operation, location: Parameter["in"]): Parameter[] {
  return operation.parameters.filter((parameter) => parameter.in === location);
}

describe("Capy OpenAPI contract fixture", () => {
  test("records the documented source and fixed production origin", () => {
    expect(fixture.source).toBe("https://docs.capy.ai/openapi.json");
    expect(fixture.openapi).toBe("3.1.0");
    expect(fixture.title).toBe("Capy API");
    expect(fixture.server).toBe("https://api.capy.ai");
    expect(CAPY_API_ORIGIN).toBe(fixture.server);
  });

  test("every implemented endpoint matches its operationId, method, and exact path", () => {
    const byOperation = new Map(Object.values(ENDPOINTS).map((endpoint) => [endpoint.operationId, endpoint]));
    expect(byOperation.size).toBe(Object.keys(fixture.operations).length);

    for (const [operationId, operation] of Object.entries(fixture.operations)) {
      const endpoint = byOperation.get(operationId);
      expect(endpoint).toBeDefined();
      expect(endpoint?.method).toBe(operation.method as "GET" | "POST");
      expect(endpoint?.path).toBe(operation.path);
    }
  });

  test("list_threads exposes exactly the documented query parameters", () => {
    const operation = fixture.operations["threads.list"]!;
    const documented = paramsFor(operation, "query").map((parameter) => parameter.name).sort();
    expect(Object.keys(schema("list_threads").properties).sort()).toEqual(documented);
    expect(schema("list_threads").required).toEqual(["projectId"]);

    const cursor = paramsFor(operation, "query").find((parameter) => parameter.name === "cursor")!;
    expect(schema("list_threads").properties.cursor?.pattern).toBe(cursor.schema.pattern);
  });

  test("list_messages uses the documented path and cursor fields", () => {
    const operation = fixture.operations["messages.list"]!;
    const path = paramsFor(operation, "path").map((parameter) => parameter.name);
    const query = paramsFor(operation, "query").map((parameter) => parameter.name);
    expect(Object.keys(schema("list_messages").properties).sort()).toEqual(
      [...path, ...query].sort(),
    );
    expect(schema("list_messages").required).toEqual(["threadId"]);

    for (const name of ["after", "before"] as const) {
      const parameter = operation.parameters.find((candidate) => candidate.name === name)!;
      const bounds = parameter.schema.allOf as { minLength?: number; maxLength?: number }[];
      expect(schema("list_messages").properties[name]?.minLength).toBe(bounds[0]?.minLength);
      expect(schema("list_messages").properties[name]?.maxLength).toBe(bounds[1]?.maxLength);
    }
  });

  test("subagent tools use the documented paths, params, and response fields", () => {
    const list = fixture.operations["subagents.list"]!;
    expect(Object.keys(schema("list_subagents").properties).sort()).toEqual(
      [...paramsFor(list, "path"), ...paramsFor(list, "query")].map((parameter) => parameter.name).sort(),
    );
    expect(schema("list_subagents").required).toEqual(["threadId"]);

    const messages = fixture.operations["subagents.messages"]!;
    expect(Object.keys(schema("list_subagent_messages").properties).sort()).toEqual(
      [...paramsFor(messages, "path"), ...paramsFor(messages, "query")]
        .map((parameter) => parameter.name)
        .sort(),
    );
    expect(schema("list_subagent_messages").required).toEqual(["subagentId"]);

    const after = paramsFor(messages, "query").find((parameter) => parameter.name === "after")!;
    const bounds = after.schema.allOf as { minLength?: number; maxLength?: number }[];
    expect(schema("list_subagent_messages").properties.after?.minLength).toBe(bounds[0]?.minLength);
    expect(schema("list_subagent_messages").properties.after?.maxLength).toBe(bounds[1]?.maxLength);

    expect(fixture.schemas.SubagentPageEncoded?.required).toEqual(
      expect.arrayContaining(["items", "cursor"]),
    );
    expect(fixture.schemas.SubagentEncoded?.required).toEqual(
      expect.arrayContaining([
        "id",
        "threadId",
        "parentId",
        "subagentPath",
        "taskPath",
        "status",
      ]),
    );
    expect(fixture.schemas.MessagePageEncoded?.required).toEqual(
      expect.arrayContaining(["items", "cursor"]),
    );
  });

  test("watch_thread uses the documented stream path and after cursor", () => {
    const operation = fixture.operations["streams.thread"]!;
    expect(schema("watch_thread").required).toEqual(["threadId"]);
    expect(schema("watch_thread").properties.threadId).toBeDefined();
    expect(schema("watch_thread").properties.cursor).toBeDefined();
    expect(paramsFor(operation, "query").map((parameter) => parameter.name)).toContain("after");

    for (const localOnly of ["maxSeconds", "maxEvents"]) {
      expect(schema("watch_thread").properties[localOnly]).toBeDefined();
      expect(paramsFor(operation, "query").map((parameter) => parameter.name)).not.toContain(
        localOnly,
      );
    }
  });

  test("create_thread sends only documented request fields plus the local confirm guard", () => {
    const request = fixture.operations["threads.create"]!.request!;
    const args = schema("create_thread");
    const sentFields = Object.keys(args.properties).filter((field) => field !== "confirm");

    for (const field of sentFields) expect(request.fields).toContain(field);
    for (const field of request.requiredFields) expect(args.required).toContain(field);
    expect(args.required.filter((field) => field !== "confirm").sort()).toEqual(request.requiredFields);
    expect(args.required).toContain("requestId");
  });

  test("send_message sends only documented request fields and requires caller idempotency", () => {
    const request = fixture.operations["messages.send"]!.request!;
    const args = schema("send_message");
    const sentFields = Object.keys(args.properties).filter(
      (field) => field !== "confirm" && field !== "threadId",
    );

    for (const field of sentFields) expect(request.fields).toContain(field);
    for (const field of request.requiredFields) expect(args.required).toContain(field);
    expect(args.required).toContain("clientKey");
  });

  test("interrupt_thread has no invented request-body fields", () => {
    expect(fixture.operations["messages.interrupt"]!.request).toBeNull();
    expect(Object.keys(schema("interrupt_thread").properties).sort()).toEqual([
      "confirm",
      "threadId",
    ]);
  });

  test("response validators cover the documented required fields", () => {
    expect(fixture.schemas.ProjectListEncoded?.required).toContain("items");
    expect(fixture.schemas.ThreadPageEncoded?.required).toEqual(
      expect.arrayContaining(["items", "cursor"]),
    );
    expect(fixture.schemas.TranscriptPageEncoded?.required).toEqual(
      expect.arrayContaining(["items", "cursor", "beforeCursor"]),
    );
    expect(fixture.schemas.MessageEncoded?.required).toEqual(
      expect.arrayContaining(["id", "source", "text", "createdAt"]),
    );
    expect(fixture.schemas.ThreadEncoded?.required).toContain("id");
    expect(fixture.schemas.AdmitReceiptEncoded?.required).toEqual(
      expect.arrayContaining(["id", "deduped"]),
    );
  });

  test("429 handling has documented retry-after metadata for read and write paths", () => {
    for (const operationId of [
      "projects.list",
      "threads.list",
      "threads.create",
      "messages.send",
      "streams.thread",
    ]) {
      const rateLimited = fixture.operations[operationId]!.errorTags.find(
        (error) => error.status === "429",
      );
      expect(rateLimited).toBeDefined();
      expect(Object.keys(rateLimited?.headers ?? {})).toContain("retry-after");
    }
  });
});
