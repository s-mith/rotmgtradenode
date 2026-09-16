import { json } from "@/server/http";
import { listenerCount, subscribe, type LiveEvent } from "@/lib/liveBus";

// GET /api/live — Server-Sent Events stream telling browsers when to refetch.
//
// Deliberately carries no data, only "something changed": `tx` for a new
// ledger row (Recent Activity + leaderboard) and `pool` for a change in the
// fleet's inventory (the grid). The client refetches the endpoint it already
// knows how to call, so there's exactly one shape of pool/activity payload in
// the codebase instead of one for load and another for updates. A pool
// refetch is answered from the watcher's shared snapshot anyway — see
// lib/liveBus.freshPoolSnapshot.
//
// Public, like the endpoints it announces: everything it can tell you about is
// already on the front page. It says nothing about WHO traded.

// Needs the Node runtime: the bus keeps a timer and cross-request state, which
// the edge runtime has no home for.

// A comment line every 25s. Two jobs: it keeps intermediaries from closing an
// idle connection, and it's how a browser that lost the network without a FIN
// finds out — no bytes, no reconnect.
const HEARTBEAT_MS = 25_000;

// Rough ceiling on open streams. Each one is a socket plus a Set entry, so the
// real cost is small, but this keeps a script from opening them without bound.
// Well clear of any plausible real audience.
const MAX_STREAMS = 500;

export async function GET(req: Request) {
  // ?group=<id>,<id>: request-status events only for these groups. Everyone
  // gets tx and pool. The site never says who a group belongs to, only that
  // it moved, so the filter is a courtesy to the wire, not a security line.
  const groups = new Set(
    (new URL(req.url).searchParams.get("group") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => /^[a-f0-9-]{32,40}$/i.test(s)),
  );
  if (listenerCount() >= MAX_STREAMS) {
    // 503 rather than 429: it's capacity, and EventSource will retry on its
    // own schedule, which is exactly the behaviour we want.
    return new Response("too many streams", { status: 503 });
  }

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;

      // Idempotent: whoever notices the stream is over calls this, and the
      // rest are no-ops.
      const teardown = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        unsubscribe = null;
        if (heartbeat !== null) clearInterval(heartbeat);
        heartbeat = null;
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client vanished between the abort signal and our next write. Tear
          // down here rather than just flagging it closed: if the abort event
          // never arrives (and it doesn't for every disconnect shape), this is
          // the only place that unsubscribes. A listener left in the Set keeps
          // the bus non-empty, which keeps the pyrelay watcher polling for a
          // browser that stopped listening long ago.
          teardown();
        }
      };

      // Open with a comment and a retry hint. The comment flushes headers
      // immediately, which is what tells a buffering proxy this response is a
      // stream and not a slow document.
      write(": connected\n\nretry: 3000\n\n");

      unsubscribe = subscribe((ev: LiveEvent) => {
        if (ev.kind === "request" && !groups.has(ev.groupId)) return;
        write(`event: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`);
      });

      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      heartbeat.unref?.();

      // The abort signal is the reliable close notification — `cancel` below
      // doesn't fire for every disconnect shape.
      if (req.signal.aborted) teardown();
      else req.signal.addEventListener("abort", teardown, { once: true });
    },

    cancel() {
      unsubscribe?.();
      unsubscribe = null;
      if (heartbeat !== null) clearInterval(heartbeat);
      heartbeat = null;
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // no-transform matters as much as no-cache: it asks proxies not to
      // buffer or recompress, which would defeat the point of streaming.
      "Cache-Control": "no-cache, no-store, no-transform",
      Connection: "keep-alive",
      // nginx-specific belt-and-braces for the same thing.
      "X-Accel-Buffering": "no",
    },
  });
}
