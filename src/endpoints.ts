export const CAPY_API_ORIGIN = "https://api.capy.ai";

export interface Endpoint {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly operationId: string;
}

export const ENDPOINTS = Object.freeze({
  listProjects: {
    method: "GET",
    path: "/api/v1/projects",
    operationId: "projects.list",
  },
  listThreads: {
    method: "GET",
    path: "/api/v1/threads",
    operationId: "threads.list",
  },
  createThread: {
    method: "POST",
    path: "/api/v1/threads",
    operationId: "threads.create",
  },
  getThread: {
    method: "GET",
    path: "/api/v1/threads/{threadId}",
    operationId: "threads.get",
  },
  listMessages: {
    method: "GET",
    path: "/api/v1/threads/{threadId}/messages",
    operationId: "messages.list",
  },
  listSubagents: {
    method: "GET",
    path: "/api/v1/threads/{threadId}/subagents",
    operationId: "subagents.list",
  },
  listSubagentMessages: {
    method: "GET",
    path: "/api/v1/subagents/{subagentId}/messages",
    operationId: "subagents.messages",
  },
  sendMessage: {
    method: "POST",
    path: "/api/v1/threads/{threadId}/message",
    operationId: "messages.send",
  },
  interruptThread: {
    method: "POST",
    path: "/api/v1/threads/{threadId}/interrupt",
    operationId: "messages.interrupt",
  },
  watchThread: {
    method: "GET",
    path: "/api/v1/threads/{threadId}/stream",
    operationId: "streams.thread",
  },
  listModels: {
    method: "GET",
    path: "/api/v1/models",
    operationId: "models.list",
  },
  usageBalance: {
    method: "GET",
    path: "/api/v1/usage/balance",
    operationId: "usage.balance",
  },
  usageReport: {
    method: "GET",
    path: "/api/v1/usage",
    operationId: "usage.get",
  },
  listTasks: {
    method: "GET",
    path: "/api/v1/threads/{threadId}/tasks",
    operationId: "tasks.list",
  },
  getTask: {
    method: "GET",
    path: "/api/v1/tasks/{taskId}",
    operationId: "tasks.get",
  },
  listTaskMessages: {
    method: "GET",
    path: "/api/v1/tasks/{taskId}/messages",
    operationId: "tasks.messages",
  },
  watchTask: {
    method: "GET",
    path: "/api/v1/tasks/{taskId}/stream",
    operationId: "streams.task",
  },
} satisfies Record<string, Endpoint>);

export function endpointPath(endpoint: Endpoint, params: Record<string, string> = {}): string {
  let path: string = endpoint.path;
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`{${key}}`, encodeURIComponent(value));
  }
  if (path.includes("{")) {
    throw new Error("Unresolved endpoint path parameter");
  }
  return path;
}
