import { normalizeApiKey } from "./config.ts";
import {
  CAPY_API_ORIGIN,
  ENDPOINTS,
  endpointPath,
} from "./endpoints.ts";
import {
  CapyError,
  abortedError,
  apiError,
  invalidResponse,
  networkError,
  timeoutError,
} from "./errors.ts";
import {
  cancelResponseBody,
  createCallControl,
  readTextBounded,
  throwIfAborted,
  type CallControl,
  type FetchLike,
} from "./http.ts";
import { consumeSse, type SseFrame } from "./sse.ts";
import {
  readId,
  readInteger,
  readOptionalInteger,
  readOptionalMessageCursor,
  readOptionalOpaqueCursor,
  readOptionalPageCursor,
  readOptionalText,
  readOptionalWatchCursor,
  readText,
  readToken,
} from "./validation.ts";

export type JsonObject = Record<string, unknown>;

export type CapyProject = JsonObject & { id: string; name: string };
export type CapyThread = JsonObject & { id: string };
export type CapyMessage = JsonObject & {
  id: string;
  source: "user" | "assistant" | "tool";
  text: string;
  createdAt: string;
};
export type CapySubagent = JsonObject & {
  id: string;
  threadId: string;
  parentId: string;
  subagentPath: string;
  taskPath: string;
  status: string;
};
export type AdmitReceipt = { id: string; deduped: boolean };

export interface ProjectList {
  items: CapyProject[];
}

export interface ThreadPage {
  items: CapyThread[];
  cursor: string | null;
}

export interface TranscriptPage {
  items: CapyMessage[];
  cursor: string | null;
  beforeCursor: string | null;
}

export interface MessagePage {
  items: CapyMessage[];
  cursor: string | null;
}

export interface SubagentPage {
  items: CapySubagent[];
  cursor: string | null;
}

export interface CapyClientOptions {
  apiKey: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface ListThreadsOptions extends RequestOptions {
  projectId: string;
  limit?: number;
  cursor?: string;
}

export interface ListMessagesOptions extends RequestOptions {
  after?: string;
  before?: string;
  limit?: number;
}

export interface ListSubagentsOptions extends RequestOptions {
  after?: string;
  limit?: number;
}

export interface ListSubagentMessagesOptions extends RequestOptions {
  after?: string;
  limit?: number;
}

export interface CreateThreadInput {
  requestId: string;
  projectId: string;
  message: string;
  title?: string;
}

export interface SendMessageInput {
  text: string;
  clientKey: string;
  delivery?: "queue" | "steer" | "interrupt";
}

export interface WatchThreadOptions extends RequestOptions {
  cursor?: string;
  maxSeconds?: number;
  maxEvents?: number;
}

export type WatchEnded =
  | "done"
  | "remote_error"
  | "time_limit"
  | "max_events"
  | "max_bytes"
  | "connection_closed";

export interface WatchSummary {
  threadId: string;
  complete: boolean;
  ended: WatchEnded;
  /** Cursor advanced only by valid committed transcript frames. */
  lastEventId: string | null;
  status: string | null;
  counts: {
    status: number;
    transcript: number;
    run: number;
    turn: number;
    assistant: number;
    toolCall: number;
    task: number;
    subagent: number;
    heartbeat: number;
    unknown: number;
    malformed: number;
  };
  runs: { started: number; ended: number };
  turns: { started: number; ended: number; lastOutcome: string | null };
  /** Committed transcript entries only. */
  transcript: CapyMessage[];
  /** Unsettled live activity, cleared at run end or a dropped turn. */
  previews: {
    assistant: { callId: string; text: string }[];
    toolCalls: { callId: string | null; name: string; text: string }[];
  };
  remoteError: { code: string; message: string } | null;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MIN_MAX_RESPONSE_BYTES = 1024;
const MAX_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 64 * 1024;
const WATCH_MAX_BYTES = 1024 * 1024;
const WATCH_MAX_SECONDS = 40;
const WATCH_DEFAULT_SECONDS = 20;
const WATCH_MAX_EVENTS = 500;
const WATCH_DEFAULT_EVENTS = 200;
const MAX_TEXT_CHARS = 100_000;
const MAX_TITLE_CHARS = 200;

function checkTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new CapyError(
      "configuration",
      `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}.`,
    );
  }
  return timeout;
}

function checkMaxResponseBytes(value: number | undefined): number {
  const max = value ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (
    !Number.isInteger(max) ||
    max < MIN_MAX_RESPONSE_BYTES ||
    max > MAX_MAX_RESPONSE_BYTES
  ) {
    throw new CapyError(
      "configuration",
      `maxResponseBytes must be an integer from ${MIN_MAX_RESPONSE_BYTES} to ${MAX_MAX_RESPONSE_BYTES}.`,
    );
  }
  return max;
}

function record(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function requireStringField(value: JsonObject, field: string, nonEmpty = false): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || (nonEmpty && fieldValue.length === 0)) {
    throw invalidResponse();
  }
  return fieldValue;
}

function projectList(value: unknown): ProjectList {
  const body = record(value);
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  for (const item of body.items) {
    const project = record(item);
    if (!project) throw invalidResponse();
    requireStringField(project, "id", true);
    requireStringField(project, "name");
  }
  return value as ProjectList;
}

function thread(value: unknown): CapyThread {
  const body = record(value);
  if (!body) throw invalidResponse();
  requireStringField(body, "id", true);
  return value as CapyThread;
}

function threadPage(value: unknown): ThreadPage {
  const body = record(value);
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  if (body.cursor !== null && typeof body.cursor !== "string") throw invalidResponse();
  for (const item of body.items) thread(item);
  return value as ThreadPage;
}

function message(value: unknown): CapyMessage {
  const body = record(value);
  if (!body) throw invalidResponse();
  requireStringField(body, "id", true);
  const source = requireStringField(body, "source");
  if (source !== "user" && source !== "assistant" && source !== "tool") throw invalidResponse();
  requireStringField(body, "text");
  requireStringField(body, "createdAt");
  return value as CapyMessage;
}

function transcriptPage(value: unknown): TranscriptPage {
  const body = record(value);
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  if (body.cursor !== null && typeof body.cursor !== "string") throw invalidResponse();
  if (body.beforeCursor !== null && typeof body.beforeCursor !== "string") {
    throw invalidResponse();
  }
  for (const item of body.items) message(item);
  return value as TranscriptPage;
}

function subagent(value: unknown): CapySubagent {
  const body = record(value);
  if (!body) throw invalidResponse();
  requireStringField(body, "id", true);
  requireStringField(body, "threadId", true);
  requireStringField(body, "parentId", true);
  requireStringField(body, "subagentPath", true);
  requireStringField(body, "taskPath", true);
  requireStringField(body, "status", true);
  if (body.projectId !== null && typeof body.projectId !== "string") throw invalidResponse();
  if (body.title !== null && typeof body.title !== "string") throw invalidResponse();
  if (typeof body.archived !== "boolean") throw invalidResponse();
  if (!record(body.usage)) throw invalidResponse();
  requireStringField(body, "createdAt");
  requireStringField(body, "updatedAt");
  if (body.lastActivityAt !== null && typeof body.lastActivityAt !== "string") {
    throw invalidResponse();
  }
  return value as CapySubagent;
}

function subagentPage(value: unknown): SubagentPage {
  const body = record(value);
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  if (body.cursor !== null && typeof body.cursor !== "string") throw invalidResponse();
  for (const item of body.items) subagent(item);
  return value as SubagentPage;
}

function messagePage(value: unknown): MessagePage {
  const body = record(value);
  if (!body || !Array.isArray(body.items)) throw invalidResponse();
  if (body.cursor !== null && typeof body.cursor !== "string") throw invalidResponse();
  for (const item of body.items) message(item);
  return value as MessagePage;
}

function admitReceipt(value: unknown): AdmitReceipt {
  const body = record(value);
  if (!body || typeof body.deduped !== "boolean") throw invalidResponse();
  requireStringField(body, "id", true);
  return value as AdmitReceipt;
}

function parseRetryAfter(value: string | null, body: JsonObject | null): number | undefined {
  if (value !== null && /^\d{1,6}$/.test(value.trim())) {
    const seconds = Number(value.trim());
    if (seconds <= 86_400) return seconds;
  }
  const fromBody = body?.retryAfterSeconds;
  if (typeof fromBody === "number" && Number.isInteger(fromBody) && fromBody >= 0 && fromBody <= 86_400) {
    return fromBody;
  }
  return undefined;
}

function errorTag(body: JsonObject | null): string | undefined {
  const tag = body?._tag;
  return typeof tag === "string" && tag.length <= 128 ? tag : undefined;
}

function queryUrl(
  path: string,
  query: Record<string, string | number | undefined> | undefined,
): URL {
  const url = new URL(path, CAPY_API_ORIGIN);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

function isMessage(value: unknown): value is CapyMessage {
  const body = record(value);
  if (!body) return false;
  return (
    typeof body.id === "string" &&
    (body.source === "user" || body.source === "assistant" || body.source === "tool") &&
    typeof body.text === "string" &&
    typeof body.createdAt === "string"
  );
}

function isTranscriptCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 26 &&
    !/[\s\u0000-\u001f\u007f]/.test(value)
  );
}

function remoteError(frame: SseFrame): { code: string; message: string } {
  let code = "unknown";
  try {
    const body = record(JSON.parse(frame.data));
    const raw = body?.code;
    if (raw === "unauthorized" || raw === "forbidden" || raw === "internal") code = raw;
  } catch {
    // A malformed error frame still ends the observation safely.
  }
  if (code === "unauthorized") {
    return {
      code,
      message: "Capy closed the stream because the API key was rejected. Replace CAPY_API_KEY and restart Magpie.",
    };
  }
  if (code === "forbidden") {
    return {
      code,
      message: "Capy closed the stream because the key lost access to the thread's project.",
    };
  }
  if (code === "internal") {
    return { code, message: "Capy closed the stream after an internal stream error." };
  }
  return { code, message: "Capy closed the stream with an unspecified error." };
}

function parseFrameData(frame: SseFrame): JsonObject | null {
  try {
    return record(JSON.parse(frame.data));
  } catch {
    return null;
  }
}

export class CapyClient {
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(options: CapyClientOptions) {
    this.apiKey = normalizeApiKey(options.apiKey, "apiKey");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = checkTimeout(options.timeoutMs);
    this.maxResponseBytes = checkMaxResponseBytes(options.maxResponseBytes);
  }

  async listProjects(options: RequestOptions = {}): Promise<ProjectList> {
    const value = await this.requestJson(ENDPOINTS.listProjects, {
      signal: options.signal,
    });
    return projectList(value);
  }

  async listThreads(options: ListThreadsOptions): Promise<ThreadPage> {
    const projectId = readId(options.projectId, "projectId");
    const limit = readOptionalInteger(options.limit, "limit", 1, 100);
    const cursor = readOptionalPageCursor(options.cursor, "cursor");
    const value = await this.requestJson(ENDPOINTS.listThreads, {
      query: { projectId, limit, cursor },
      signal: options.signal,
    });
    return threadPage(value);
  }

  async getThread(threadId: string, options: RequestOptions = {}): Promise<CapyThread> {
    const id = readId(threadId, "threadId");
    const value = await this.requestJson(ENDPOINTS.getThread, {
      pathParams: { threadId: id },
      signal: options.signal,
    });
    return thread(value);
  }

  async listMessages(
    threadId: string,
    options: ListMessagesOptions = {},
  ): Promise<TranscriptPage> {
    const id = readId(threadId, "threadId");
    const after = readOptionalMessageCursor(options.after, "after");
    const before = readOptionalMessageCursor(options.before, "before");
    const limit = readOptionalInteger(options.limit, "limit", 1, 100);
    const value = await this.requestJson(ENDPOINTS.listMessages, {
      pathParams: { threadId: id },
      query: { after, before, limit },
      signal: options.signal,
    });
    return transcriptPage(value);
  }

  async listSubagents(
    threadId: string,
    options: ListSubagentsOptions = {},
  ): Promise<SubagentPage> {
    const id = readId(threadId, "threadId");
    const after = readOptionalOpaqueCursor(options.after, "after");
    const limit = readOptionalInteger(options.limit, "limit", 1, 100);
    const value = await this.requestJson(ENDPOINTS.listSubagents, {
      pathParams: { threadId: id },
      query: { after, limit },
      signal: options.signal,
    });
    return subagentPage(value);
  }

  async listSubagentMessages(
    subagentId: string,
    options: ListSubagentMessagesOptions = {},
  ): Promise<MessagePage> {
    const id = readId(subagentId, "subagentId");
    const after = readOptionalMessageCursor(options.after, "after");
    const limit = readOptionalInteger(options.limit, "limit", 1, 100);
    const value = await this.requestJson(ENDPOINTS.listSubagentMessages, {
      pathParams: { subagentId: id },
      query: { after, limit },
      signal: options.signal,
    });
    return messagePage(value);
  }

  async createThread(input: CreateThreadInput, options: RequestOptions = {}): Promise<CapyThread> {
    const requestId = readToken(input.requestId, "requestId", 191);
    const projectId = readId(input.projectId, "projectId");
    const messageText = readText(input.message, "message", MAX_TEXT_CHARS);
    const title = readOptionalText(input.title, "title", MAX_TITLE_CHARS);
    const value = await this.requestJson(ENDPOINTS.createThread, {
      method: "POST",
      body: {
        requestId,
        projectId,
        message: messageText,
        ...(title !== undefined ? { title } : {}),
      },
      signal: options.signal,
    });
    return thread(value);
  }

  async sendMessage(
    threadId: string,
    input: SendMessageInput,
    options: RequestOptions = {},
  ): Promise<AdmitReceipt> {
    const id = readId(threadId, "threadId");
    const text = readText(input.text, "text", MAX_TEXT_CHARS);
    const clientKey = readToken(input.clientKey, "clientKey", 64);
    const delivery = input.delivery;
    if (delivery !== undefined && delivery !== "queue" && delivery !== "steer" && delivery !== "interrupt") {
      throw new CapyError(
        "invalid_arguments",
        "delivery must be queue, steer, or interrupt.",
      );
    }
    const value = await this.requestJson(ENDPOINTS.sendMessage, {
      method: "POST",
      pathParams: { threadId: id },
      body: {
        text,
        clientKey,
        ...(delivery !== undefined ? { delivery } : {}),
      },
      signal: options.signal,
    });
    return admitReceipt(value);
  }

  async interruptThread(threadId: string, options: RequestOptions = {}): Promise<AdmitReceipt> {
    const id = readId(threadId, "threadId");
    const value = await this.requestJson(ENDPOINTS.interruptThread, {
      method: "POST",
      pathParams: { threadId: id },
      signal: options.signal,
    });
    return admitReceipt(value);
  }

  async watchThread(threadId: string, options: WatchThreadOptions = {}): Promise<WatchSummary> {
    const id = readId(threadId, "threadId");
    const cursor = readOptionalWatchCursor(options.cursor, "cursor");
    const maxSeconds = readInteger(
      options.maxSeconds ?? WATCH_DEFAULT_SECONDS,
      "maxSeconds",
      1,
      WATCH_MAX_SECONDS,
    );
    const maxEvents = readInteger(
      options.maxEvents ?? WATCH_DEFAULT_EVENTS,
      "maxEvents",
      1,
      WATCH_MAX_EVENTS,
    );

    const summary: WatchSummary = {
      threadId: id,
      complete: false,
      ended: "connection_closed",
      lastEventId: null,
      status: null,
      counts: {
        status: 0,
        transcript: 0,
        run: 0,
        turn: 0,
        assistant: 0,
        toolCall: 0,
        task: 0,
        subagent: 0,
        heartbeat: 0,
        unknown: 0,
        malformed: 0,
      },
      runs: { started: 0, ended: 0 },
      turns: { started: 0, ended: 0, lastOutcome: null },
      transcript: [],
      previews: { assistant: [], toolCalls: [] },
      remoteError: null,
    };
    const assistantPreviews = new Map<string, string>();
    const toolCallPreviews: { callId: string | null; name: string; text: string }[] = [];
    const committedAssistantCallIds = new Set<string>();
    const committedToolCallIds = new Set<string>();

    const syncPreviews = () => {
      summary.previews.assistant = [...assistantPreviews].map(([callId, text]) => ({
        callId,
        text,
      }));
      summary.previews.toolCalls = [...toolCallPreviews];
    };
    const clearPreviews = () => {
      assistantPreviews.clear();
      toolCallPreviews.length = 0;
    };

    const { response, control } = await this.open(ENDPOINTS.watchThread, {
      pathParams: { threadId: id },
      query: { after: cursor },
      signal: options.signal,
      timeoutMs: maxSeconds * 1000,
      accept: "text/event-stream",
    });

    try {
      if (!response.body) throw invalidResponse();
      const result = await consumeSse(response.body, {
        maxBytes: WATCH_MAX_BYTES,
        maxEvents,
        signal: control.signal,
        onEvent: (frame) => {
          if (frame.event === "done") {
            summary.ended = "done";
            summary.complete = true;
            return false;
          }
          if (frame.event === "error") {
            summary.remoteError = remoteError(frame);
            summary.ended = "remote_error";
            return false;
          }

          const data = parseFrameData(frame);
          switch (frame.event) {
            case "status": {
              summary.counts.status += 1;
              if (!data || typeof data.status !== "string") {
                summary.counts.malformed += 1;
                break;
              }
              summary.status = data.status;
              break;
            }
            case "transcript": {
              summary.counts.transcript += 1;
              if (!isMessage(data)) {
                summary.counts.malformed += 1;
                break;
              }
              summary.transcript.push(data);
              if (data.source === "assistant") {
                if (typeof data.callId === "string") {
                  committedAssistantCallIds.add(data.callId);
                  assistantPreviews.delete(data.callId);
                }
              } else if (data.source === "tool") {
                committedToolCallIds.add(data.id);
                for (let index = toolCallPreviews.length - 1; index >= 0; index--) {
                  if (toolCallPreviews[index]?.callId === data.id) toolCallPreviews.splice(index, 1);
                }
              }
              if (isTranscriptCursor(frame.id)) summary.lastEventId = frame.id;
              break;
            }
            case "run": {
              summary.counts.run += 1;
              if (!data || (data.phase !== "start" && data.phase !== "end")) {
                summary.counts.malformed += 1;
                break;
              }
              if (data.phase === "start") {
                summary.runs.started += 1;
              } else {
                summary.runs.ended += 1;
                clearPreviews();
              }
              break;
            }
            case "turn": {
              summary.counts.turn += 1;
              if (!data || (data.phase !== "start" && data.phase !== "end")) {
                summary.counts.malformed += 1;
                break;
              }
              if (data.phase === "start") {
                summary.turns.started += 1;
              } else {
                summary.turns.ended += 1;
                const outcome =
                  data.outcome === "settled" ||
                  data.outcome === "aborted" ||
                  data.outcome === "dropped"
                    ? data.outcome
                    : null;
                summary.turns.lastOutcome = outcome;
                if (outcome === "dropped") clearPreviews();
              }
              break;
            }
            case "assistant": {
              summary.counts.assistant += 1;
              if (
                !data ||
                typeof data.callId !== "string" ||
                typeof data.text !== "string"
              ) {
                summary.counts.malformed += 1;
                break;
              }
              if (committedAssistantCallIds.has(data.callId)) break;
              assistantPreviews.set(
                data.callId,
                (assistantPreviews.get(data.callId) ?? "") + data.text,
              );
              break;
            }
            case "tool_call": {
              summary.counts.toolCall += 1;
              if (
                !data ||
                typeof data.name !== "string" ||
                typeof data.text !== "string"
              ) {
                summary.counts.malformed += 1;
                break;
              }
              const callId = typeof data.callId === "string" ? data.callId : null;
              if (callId !== null && committedToolCallIds.has(callId)) break;
              const preview = { callId, name: data.name, text: data.text };
              const existing =
                callId === null
                  ? -1
                  : toolCallPreviews.findIndex((candidate) => candidate.callId === callId);
              if (existing >= 0) toolCallPreviews[existing] = preview;
              else toolCallPreviews.push(preview);
              break;
            }
            case "task":
              summary.counts.task += 1;
              break;
            case "subagent":
              summary.counts.subagent += 1;
              break;
            case "heartbeat":
              summary.counts.heartbeat += 1;
              break;
            default:
              summary.counts.unknown += 1;
              break;
          }
          return true;
        },
      });

      if (result.reason === "max_bytes") summary.ended = "max_bytes";
      else if (result.reason === "max_events") summary.ended = "max_events";
      else if (summary.ended !== "done" && summary.ended !== "remote_error") {
        summary.ended = "connection_closed";
      }
      syncPreviews();
      summary.complete = summary.ended === "done";
      return summary;
    } catch (error) {
      if (options.signal?.aborted) throw abortedError();
      if (control.timedOut()) {
        summary.ended = "time_limit";
        summary.complete = false;
        syncPreviews();
        return summary;
      }
      if (error instanceof CapyError) throw error;
      throw networkError();
    } finally {
      control.cleanup();
    }
  }

  private async requestJson(
    endpoint: (typeof ENDPOINTS)[keyof typeof ENDPOINTS],
    options: {
      method?: "GET" | "POST";
      pathParams?: Record<string, string>;
      query?: Record<string, string | number | undefined>;
      body?: JsonObject;
      signal?: AbortSignal;
      timeoutMs?: number;
    },
  ): Promise<unknown> {
    const { response, control } = await this.open(endpoint, options);
    try {
      let text: string;
      try {
        text = await readTextBounded(response, this.maxResponseBytes);
      } catch (error) {
        if (error instanceof CapyError) throw error;
        if (options.signal?.aborted) throw abortedError();
        if (control.timedOut()) throw timeoutError();
        throw networkError();
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw invalidResponse();
      }
    } finally {
      control.cleanup();
    }
  }

  private async open(
    endpoint: (typeof ENDPOINTS)[keyof typeof ENDPOINTS],
    options: {
      method?: "GET" | "POST";
      pathParams?: Record<string, string>;
      query?: Record<string, string | number | undefined>;
      body?: JsonObject;
      signal?: AbortSignal;
      timeoutMs?: number;
      accept?: string;
    },
  ): Promise<{ response: Response; control: CallControl }> {
    throwIfAborted(options.signal);
    const control = createCallControl(options.signal, options.timeoutMs ?? this.timeoutMs);
    const method = options.method ?? endpoint.method;
    const url = queryUrl(endpointPath(endpoint, options.pathParams), options.query);
    const headers = new Headers({ accept: options.accept ?? "application/json" });
    headers.set("authorization", `Bearer ${this.apiKey}`);
    if (options.body !== undefined) headers.set("content-type", "application/json");

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          redirect: "manual",
          cache: "no-store",
          credentials: "omit",
          signal: control.signal,
          ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        });
      } catch (error) {
        if (options.signal?.aborted) throw abortedError();
        if (control.timedOut()) throw timeoutError();
        if (error instanceof CapyError) throw error;
        throw networkError();
      }

      if (response.status >= 300 && response.status < 400) {
        await cancelResponseBody(response);
        throw new CapyError(
          "redirect_refused",
          "The Capy API returned an HTTP redirect. It was not followed because requests carry an API key.",
          { status: response.status },
        );
      }

      if (!response.ok) {
        const { tag, retryAfterSeconds } = await this.errorMetadata(response);
        throw apiError(response.status, tag, retryAfterSeconds);
      }

      return { response, control };
    } catch (error) {
      control.cleanup();
      throw error;
    }
  }

  private async errorMetadata(
    response: Response,
  ): Promise<{ tag?: string; retryAfterSeconds?: number }> {
    let body: JsonObject | null = null;
    try {
      const text = await readTextBounded(response, MAX_ERROR_BODY_BYTES);
      body = record(JSON.parse(text) as unknown);
    } catch {
      // Error bodies are optional and untrusted; status/tag mapping stands without them.
    }
    const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), body);
    const tag = errorTag(body);
    return {
      ...(tag !== undefined ? { tag } : {}),
      ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    };
  }
}

export function createCapyClient(options: CapyClientOptions): CapyClient {
  return new CapyClient(options);
}
