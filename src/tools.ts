import { createCapyClient } from "./client.ts";
import { CapyError } from "./errors.ts";
import {
  assertConfirmed,
  assertWritesEnabled,
  normalizeApiKey,
  readApiKey,
  type Environment,
} from "./config.ts";
import type { FetchLike } from "./http.ts";
import {
  readId,
  readOptionalInteger,
  readOptionalMessageCursor,
  readOptionalOpaqueCursor,
  readOptionalPageCursor,
  readOptionalText,
  readOptionalWatchCursor,
  readText,
  readToken,
  validateToolArgs,
} from "./validation.ts";

export interface ToolContext {
  abort?: AbortSignal;
  [key: string]: unknown;
}

export interface ToolDefinition {
  description: string;
  args: Record<string, unknown>;
  execute(args: unknown, ctx?: ToolContext): Promise<unknown>;
}

export interface PluginOptions {
  allowWrites?: boolean;
  [key: string]: unknown;
}

export interface PluginInput {
  magpie?: {
    options?: PluginOptions;
    account?: (provider: string) => string;
  };
  [key: string]: unknown;
}

export interface ToolRuntime {
  fetchImpl?: FetchLike;
  env?: Environment;
  hostApiKey?: () => string | null;
  hostApiKeyError?: () => string | null;
}

const ID_SCHEMA = {
  type: "string",
  minLength: 1,
  maxLength: 191,
  pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$",
} as const;

const TOKEN_SCHEMA = {
  type: "string",
  minLength: 1,
  pattern: "^[A-Za-z0-9._:-]+$",
} as const;

const MESSAGE_CURSOR_SCHEMA = {
  type: "string",
  minLength: 26,
  maxLength: 26,
  pattern: "^[A-Za-z0-9_-]{26}$",
} as const;

const LIMIT_SCHEMA = {
  type: "integer",
  minimum: 1,
  maximum: 100,
} as const;

const CONFIRM_SCHEMA = {
  type: "boolean",
  description:
    "Must be true for this exact write invocation. This is a caller assertion, not a human-approval UI or authorization boundary; the host/user must enforce approval.",
} as const;

export const TOOL_SCHEMAS = Object.freeze({
  list_projects: {
    type: "object",
    properties: {},
    required: [],
    additionalProperties: false,
  },
  list_threads: {
    type: "object",
    properties: {
      projectId: { ...ID_SCHEMA, description: "A Capy project id from list_projects." },
      limit: LIMIT_SCHEMA,
      cursor: {
        type: "string",
        minLength: 3,
        maxLength: 512,
        pattern: "^\\d{1,15}:.+",
        description: "The cursor from a previous list_threads page. Return it unchanged.",
      },
    },
    required: ["projectId"],
    additionalProperties: false,
  },
  get_thread: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The Capy thread id." },
    },
    required: ["threadId"],
    additionalProperties: false,
  },
  list_messages: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The Capy thread id." },
      after: {
        ...MESSAGE_CURSOR_SCHEMA,
        description: "Forward cursor from a previous page's cursor. Return it unchanged.",
      },
      before: {
        ...MESSAGE_CURSOR_SCHEMA,
        description: "Backward cursor from a previous page's beforeCursor. Return it unchanged.",
      },
      limit: LIMIT_SCHEMA,
    },
    required: ["threadId"],
    additionalProperties: false,
  },
  list_subagents: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The parent Capy thread id." },
      after: {
        type: "string",
        minLength: 1,
        maxLength: 512,
        pattern: "^\\S+$",
        description: "Opaque forward cursor from a previous list_subagents page. Return it unchanged.",
      },
      limit: LIMIT_SCHEMA,
    },
    required: ["threadId"],
    additionalProperties: false,
  },
  list_subagent_messages: {
    type: "object",
    properties: {
      subagentId: { ...ID_SCHEMA, description: "A subagent id from list_subagents." },
      after: {
        ...MESSAGE_CURSOR_SCHEMA,
        description: "Forward cursor from a previous page's cursor. Return it unchanged.",
      },
      limit: LIMIT_SCHEMA,
    },
    required: ["subagentId"],
    additionalProperties: false,
  },
  watch_thread: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The Capy thread id." },
      cursor: {
        type: "string",
        minLength: 1,
        maxLength: 256,
        pattern: "^\\S+$",
        description:
          "Omit on the first observation. To resume, pass the exact lastEventId from a previous watch_thread result; never invent a cursor.",
      },
      maxSeconds: {
        type: "integer",
        minimum: 1,
        maximum: 40,
        default: 20,
        description: "Bounded local observation time. Reaching it is not a failure.",
      },
      maxEvents: {
        type: "integer",
        minimum: 1,
        maximum: 500,
        default: 200,
        description: "Bound on parsed SSE frames collected in one call.",
      },
    },
    required: ["threadId"],
    additionalProperties: false,
  },
  create_thread: {
    type: "object",
    properties: {
      requestId: {
        ...TOKEN_SCHEMA,
        maxLength: 191,
        description:
          "Caller-supplied idempotency token. Reuse the exact value when retrying; the plugin never generates one.",
      },
      projectId: { ...ID_SCHEMA, description: "A Capy project id from list_projects." },
      message: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description:
          "The opening task. Capy may run commands, spend credits, or open pull requests depending on this text and project settings.",
      },
      title: { type: "string", minLength: 1, maxLength: 200 },
      confirm: CONFIRM_SCHEMA,
    },
    required: ["requestId", "projectId", "message", "confirm"],
    additionalProperties: false,
  },
  send_message: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The Capy thread id." },
      text: {
        type: "string",
        minLength: 1,
        maxLength: 100000,
        description:
          "The message. It may wake the agent and cause billable/external actions under the thread's instructions.",
      },
      clientKey: {
        ...TOKEN_SCHEMA,
        maxLength: 64,
        description:
          "Caller-supplied idempotency key. Reuse the exact value when retrying; the plugin never generates one.",
      },
      delivery: {
        type: "string",
        enum: ["queue", "steer", "interrupt"],
        description: "How Capy delivers the message to a working thread.",
      },
      confirm: CONFIRM_SCHEMA,
    },
    required: ["threadId", "text", "clientKey", "confirm"],
    additionalProperties: false,
  },
  interrupt_thread: {
    type: "object",
    properties: {
      threadId: { ...ID_SCHEMA, description: "The Capy thread id." },
      confirm: CONFIRM_SCHEMA,
    },
    required: ["threadId", "confirm"],
    additionalProperties: false,
  },
} satisfies Record<string, Record<string, unknown>>);

const WRITE_EFFECTS =
  "Creating or messaging a Capy thread may run project commands, spend credits, or open pull requests depending on the instructions and project settings.";

export function createCapyToolsPlugin(runtime: ToolRuntime = {}) {
  return async (
    input?: PluginInput,
    options?: PluginOptions,
  ): Promise<{ tool: Record<string, ToolDefinition> }> => {
    const env = runtime.env ?? process.env;
    const allowWrites = (options ?? input?.magpie?.options)?.allowWrites === true;
    const apiKey = () => {
      const fromEnv = env.CAPY_API_KEY;
      if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
        return normalizeApiKey(fromEnv, "CAPY_API_KEY");
      }
      const fromHost = runtime.hostApiKey?.();
      if (typeof fromHost === "string" && fromHost.trim() !== "") {
        return normalizeApiKey(fromHost, "Capy 登录");
      }
      const hostError = runtime.hostApiKeyError?.();
      if (hostError) throw new CapyError("configuration", hostError);
      return readApiKey(env);
    };
    const client = () =>
      createCapyClient({
        apiKey: apiKey(),
        ...(runtime.fetchImpl !== undefined ? { fetchImpl: runtime.fetchImpl } : {}),
      });

    const tools: Record<string, ToolDefinition> = {
      list_projects: {
        description:
          "List Capy projects visible to the configured API key. Read-only. Use the returned project id with list_threads or create_thread.",
        args: TOOL_SCHEMAS.list_projects,
        async execute(raw, ctx) {
          validateToolArgs(raw, []);
          return client().listProjects({ signal: ctx?.abort });
        },
      },

      list_threads: {
        description:
          "List Capy threads in one project. Read-only. Returns items plus the next cursor; pass that cursor back unchanged to page forward.",
        args: TOOL_SCHEMAS.list_threads,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["projectId", "limit", "cursor"]);
          const projectId = readId(args.projectId, "projectId");
          const limit = readOptionalInteger(args.limit, "limit", 1, 100);
          const cursor = readOptionalPageCursor(args.cursor, "cursor");
          return client().listThreads({
            projectId,
            ...(limit !== undefined ? { limit } : {}),
            ...(cursor !== undefined ? { cursor } : {}),
            signal: ctx?.abort,
          });
        },
      },

      get_thread: {
        description:
          "Get one Capy thread's documented status and metadata. Read-only. Thread status is one of working, waiting, idle, failed, or archived.",
        args: TOOL_SCHEMAS.get_thread,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["threadId"]);
          const threadId = readId(args.threadId, "threadId");
          return client().getThread(threadId, { signal: ctx?.abort });
        },
      },

      list_messages: {
        description:
          "List one page of a Capy thread transcript. Read-only. Returns items plus cursor (forward) and beforeCursor (backward); pass either back unchanged. Cursors are never discarded automatically.",
        args: TOOL_SCHEMAS.list_messages,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["threadId", "after", "before", "limit"]);
          const threadId = readId(args.threadId, "threadId");
          const after = readOptionalMessageCursor(args.after, "after");
          const before = readOptionalMessageCursor(args.before, "before");
          const limit = readOptionalInteger(args.limit, "limit", 1, 100);
          return client().listMessages(threadId, {
            ...(after !== undefined ? { after } : {}),
            ...(before !== undefined ? { before } : {}),
            ...(limit !== undefined ? { limit } : {}),
            signal: ctx?.abort,
          });
        },
      },

      list_subagents: {
        description:
          "List the direct subagents recorded for a Capy thread. Read-only. Returns each subagent's id, parentId, subagentPath, taskPath, status, and the next cursor. Paths are server-provided labels; do not invent hierarchy. Use list_subagent_messages to read a subagent's own transcript.",
        args: TOOL_SCHEMAS.list_subagents,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["threadId", "after", "limit"]);
          const threadId = readId(args.threadId, "threadId");
          const after = readOptionalOpaqueCursor(args.after, "after");
          const limit = readOptionalInteger(args.limit, "limit", 1, 100);
          return client().listSubagents(threadId, {
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
            signal: ctx?.abort,
          });
        },
      },

      list_subagent_messages: {
        description:
          "List one page of a Capy subagent's own transcript. Read-only. Returns items plus the forward cursor; pass that cursor back unchanged. This does not read the parent thread transcript.",
        args: TOOL_SCHEMAS.list_subagent_messages,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["subagentId", "after", "limit"]);
          const subagentId = readId(args.subagentId, "subagentId");
          const after = readOptionalMessageCursor(args.after, "after");
          const limit = readOptionalInteger(args.limit, "limit", 1, 100);
          return client().listSubagentMessages(subagentId, {
            ...(after !== undefined ? { after } : {}),
            ...(limit !== undefined ? { limit } : {}),
            signal: ctx?.abort,
          });
        },
      },

      watch_thread: {
        description:
          "Observe a Capy thread over its documented SSE endpoint for a bounded time, returning collected progress (status changes, run/turn phases, committed transcript entries, and only unsettled live previews). Unsettled previews are discarded at run end. lastEventId advances only for committed transcript frames and is the value to resume from. This is not server-pushed MCP streaming; each call returns once. Cancelling it stops local observation only and never stops the remote thread. Read-only.",
        args: TOOL_SCHEMAS.watch_thread,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["threadId", "cursor", "maxSeconds", "maxEvents"]);
          const threadId = readId(args.threadId, "threadId");
          const cursor = readOptionalWatchCursor(args.cursor, "cursor");
          const maxSeconds = readOptionalInteger(args.maxSeconds, "maxSeconds", 1, 40);
          const maxEvents = readOptionalInteger(args.maxEvents, "maxEvents", 1, 500);
          return client().watchThread(threadId, {
            ...(cursor !== undefined ? { cursor } : {}),
            ...(maxSeconds !== undefined ? { maxSeconds } : {}),
            ...(maxEvents !== undefined ? { maxEvents } : {}),
            signal: ctx?.abort,
          });
        },
      },

      create_thread: {
        description:
          `Create a new Capy thread and start its opening task. WRITE: disabled unless CAPY_ALLOW_WRITES=true, and confirm must be true. ${WRITE_EFFECTS} requestId is caller-supplied and reused verbatim on retries; the plugin never generates one.`,
        args: TOOL_SCHEMAS.create_thread,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, [
            "requestId",
            "projectId",
            "message",
            "title",
            "confirm",
          ]);
          const requestId = readToken(args.requestId, "requestId", 191);
          const projectId = readId(args.projectId, "projectId");
          const message = readText(args.message, "message", 100_000);
          const title = readOptionalText(args.title, "title", 200);
          assertWritesEnabled(env, allowWrites);
          assertConfirmed(args.confirm === true);
          return client().createThread(
            {
              requestId,
              projectId,
              message,
              ...(title !== undefined ? { title } : {}),
            },
            { signal: ctx?.abort },
          );
        },
      },

      send_message: {
        description:
          `Send a message to an existing Capy thread. WRITE: disabled unless CAPY_ALLOW_WRITES=true, and confirm must be true. ${WRITE_EFFECTS} clientKey is caller-supplied and reused verbatim on retries; the plugin never generates one.`,
        args: TOOL_SCHEMAS.send_message,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, [
            "threadId",
            "text",
            "clientKey",
            "delivery",
            "confirm",
          ]);
          const threadId = readId(args.threadId, "threadId");
          const text = readText(args.text, "text", 100_000);
          const clientKey = readToken(args.clientKey, "clientKey", 64);
          const delivery = args.delivery;
          if (
            delivery !== undefined &&
            delivery !== "queue" &&
            delivery !== "steer" &&
            delivery !== "interrupt"
          ) {
            throw new CapyError(
              "invalid_arguments",
              "delivery must be queue, steer, or interrupt.",
            );
          }
          assertWritesEnabled(env, allowWrites);
          assertConfirmed(args.confirm === true);
          return client().sendMessage(
            threadId,
            {
              text,
              clientKey,
              ...(delivery !== undefined ? { delivery } : {}),
            },
            { signal: ctx?.abort },
          );
        },
      },

      interrupt_thread: {
        description:
          "Interrupt the run in progress on a Capy thread. WRITE: disabled unless CAPY_ALLOW_WRITES=true, and confirm must be true. This is an explicit remote stop, separate from cancelling watch_thread. No retry is attempted.",
        args: TOOL_SCHEMAS.interrupt_thread,
        async execute(raw, ctx) {
          const args = validateToolArgs(raw, ["threadId", "confirm"]);
          const threadId = readId(args.threadId, "threadId");
          assertWritesEnabled(env, allowWrites);
          assertConfirmed(args.confirm === true);
          return client().interruptThread(threadId, { signal: ctx?.abort });
        },
      },
    };

    return { tool: tools };
  };
}
