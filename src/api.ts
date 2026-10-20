import type { ProgressEvent, ResearchResponse } from "./types";

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function errorFrom(res: Response): Promise<ApiError> {
  let message = res.statusText;
  try {
    const body = await res.json();
    // FastAPI: {detail: string} or {detail: [{msg, ...}]} for validation errors
    message = typeof body.detail === "string" ? body.detail : (body.detail?.[0]?.msg ?? message);
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(res.status, message);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) throw await errorFrom(res);
  return res.json() as Promise<T>;
}

export interface StreamHandlers {
  onProgress: (event: ProgressEvent) => void;
  /** Next piece of the draft notes (Markdown). */
  onDraft: (delta: string) => void;
  /** A new draft attempt started; discard any draft text received so far. */
  onDraftReset: () => void;
}

/**
 * POST to an SSE endpoint and dispatch events as they arrive.
 * (EventSource only supports GET, so the stream is read from fetch directly.)
 * Resolves with the final `result` event; rejects on an `error` event or a dropped stream.
 */
async function streamRequest(
  path: string,
  body: unknown,
  handlers: StreamHandlers,
): Promise<ResearchResponse> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await errorFrom(res);
  if (!res.body) throw new Error("Streaming is not supported by this browser");

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let result: ResearchResponse | null = null;

  const handleFrame = (frame: string) => {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const data = JSON.parse(dataLines.join("\n"));
    if (event === "progress") handlers.onProgress(data as ProgressEvent);
    else if (event === "draft") handlers.onDraft(data.delta as string);
    else if (event === "draft_reset") handlers.onDraftReset();
    else if (event === "result") result = data as ResearchResponse;
    else if (event === "error") throw new Error(data.detail ?? "Run failed");
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      handleFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
    }
  }
  if (!result) throw new Error("The stream ended before a result arrived");
  return result;
}

/** Streamed (SSE) when `handlers` are given; otherwise a single blocking request. */
export const startResearch = (topic: string, handlers?: StreamHandlers) =>
  handlers
    ? streamRequest("/research/stream", { topic }, handlers)
    : request<ResearchResponse>("/research", { method: "POST", body: JSON.stringify({ topic }) });

export const getResearch = (threadId: string) =>
  request<ResearchResponse>(`/research/${encodeURIComponent(threadId)}`);

export const submitReview = (
  threadId: string,
  decision: string,
  handlers?: StreamHandlers,
) => {
  const path = `/research/${encodeURIComponent(threadId)}/review`;
  return handlers
    ? streamRequest(`${path}/stream`, { decision }, handlers)
    : request<ResearchResponse>(path, { method: "POST", body: JSON.stringify({ decision }) });
};
