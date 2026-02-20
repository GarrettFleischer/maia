import { NextRequest } from "next/server";
import { subscribe } from "@/lib/events";
import type { SystemSSEEvent } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      function send(event: SystemSSEEvent) {
        const line = `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
        controller.enqueue(encoder.encode(line));
      }

      // Keep-alive ping every 15s
      const pingInterval = setInterval(() => {
        send({ event: "ping", data: { timestamp: new Date().toISOString() } });
      }, 15_000);

      const unsubscribe = subscribe(send);

      // Clean up when client disconnects
      _req.signal.addEventListener("abort", () => {
        clearInterval(pingInterval);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
