/**
 * SSE proxy: forwards the browser's chat request to the FastAPI backend and
 * pipes the event stream straight back. Keeping the backend behind a same-origin
 * route avoids CORS and hides the backend URL from the client.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();

  const upstream = await fetch(`${BACKEND_URL}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    // @ts-expect-error — Node fetch streaming duplex flag, not yet in lib types
    duplex: "half",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}
