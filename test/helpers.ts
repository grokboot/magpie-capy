import type { FetchLike } from "../src/http.ts";

export const TEST_KEY = "capy_test_SYNTHETIC_0000000000000000";
export const TEST_ENV = { CAPY_API_KEY: TEST_KEY };

export interface FetchCall {
  url: URL;
  init: RequestInit;
}

export interface FetchStub {
  fetchImpl: FetchLike;
  calls: FetchCall[];
}

export function makeFetch(
  handler: (url: URL, init: RequestInit) => Response | Promise<Response>,
): FetchStub {
  const calls: FetchCall[] = [];
  const fetchImpl: FetchLike = async (input, init = {}) => {
    const url = new URL(input instanceof URL ? input.toString() : input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetchImpl, calls };
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function requestBody(call: FetchCall): Record<string, unknown> {
  if (typeof call.init.body !== "string") throw new Error("expected a JSON request body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

export function requestHeaders(call: FetchCall): Headers {
  return new Headers(call.init.headers);
}

export function sseResponse(frames: string, splitAt: number[] = []): Response {
  const bytes = new TextEncoder().encode(frames);
  let offset = 0;
  const boundaries = [...splitAt, bytes.length].sort((a, b) => a - b);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const boundary = boundaries.shift();
      if (boundary === undefined) return;
      controller.enqueue(bytes.slice(offset, boundary));
      offset = boundary;
      if (boundaries.length === 0) controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}
