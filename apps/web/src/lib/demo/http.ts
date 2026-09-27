import { DEMO_NOTICE_EVENT } from "../demo-mode";

/** Real Response objects for the in-browser demo API. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function problem(status: number, detail: unknown): Response {
  return json({ detail }, status);
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type SseFrame = { event: string; data: unknown; delayMs?: number };

/** A text/event-stream response whose frames arrive with small delays, so streaming visibly animates. */
export function sse(frames: () => AsyncIterable<SseFrame>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const frame of frames()) {
          if (frame.delayMs) await wait(frame.delayMs);
          controller.enqueue(encoder.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`));
        }
      } catch {
        controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify("The demo stream stopped unexpectedly.")}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
}

/** Shows a short "Demo: …" note for an action that would reach the outside world in a real workspace. */
export function notify(message: string): void {
  if (typeof window === "undefined") return;
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(DEMO_NOTICE_EVENT, { detail: message })), 0);
}

export async function readBody(body: BodyInit | null | undefined): Promise<{ json: Record<string, unknown>; form: FormData | null }> {
  if (!body) return { json: {}, form: null };
  if (typeof FormData !== "undefined" && body instanceof FormData) return { json: {}, form: body };
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return { json: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}, form: null };
    } catch { return { json: {}, form: null }; }
  }
  return { json: {}, form: null };
}

export const str = (value: unknown): string | null => typeof value === "string" ? value : null;
export const strList = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export const bool = (value: unknown, fallback = false): boolean => typeof value === "boolean" ? value : fallback;
