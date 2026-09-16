import { acceptsGzip, etagMatches, json } from "@/server/http";
import { deltaGzip, fullBytes, fullGzip, poolDelta, poolSnapshotError, refreshPoolSnapshot } from "@/lib/poolSnapshot";

// GET /api/pool
// The fleet's tracked inventory in the compact wire form of lib/poolWire.ts,
// served from the snapshot lib/poolSnapshot.ts keeps: built once per distinct
// fleet state, gzipped once, handed to every request as the same bytes.
//
//   GET /api/pool                 the whole pool (~3 MB, ~1.3 MB gzipped), with
//                                 an ETag; If-None-Match answers 304.
//   GET /api/pool?since=<rev>     only the bots that changed since that
//                                 revision (a few KB), or the whole pool when
//                                 the history no longer reaches it.
//
// The live stream (/api/live) tells browsers the current revision; the page
// asks for the delta. This endpoint was ~99% of the site's egress when it
// re-sent a 13.5 MB per-instance list to every tab on every change.

/** Deltas smaller than this go out as plain text; a gzip header would not pay for itself. */
const GZIP_MIN_BYTES = 1024;
const JSON_TYPE = "application/json; charset=utf-8";

function send(body: Buffer | string, opts: { gzip?: Buffer | null; etag?: string }): Response {
  const headers = new Headers({ "Content-Type": JSON_TYPE, "Cache-Control": "no-cache", Vary: "Accept-Encoding" });
  if (opts.etag) headers.set("ETag", opts.etag);
  let bytes: Buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  if (opts.gzip) {
    bytes = opts.gzip;
    headers.set("Content-Encoding", "gzip");
  }
  headers.set("Content-Length", String(bytes.length));
  return new Response(bytes, { status: 200, headers });
}

export async function GET(req: Request): Promise<Response> {
  const snap = await refreshPoolSnapshot();
  if (!snap) {
    // Never reached the fleet: say so in the shape the page expects, so it can
    // show "bot service unreachable" instead of an indistinguishable empty pool.
    return json({ v: 2, rev: "", full: true, bots: {}, items: {}, enchants: {}, catalog: [], error: poolSnapshotError() ?? "pyrelay: unavailable" });
  }
  const gz = acceptsGzip(req.headers.get("accept-encoding"));
  const params = new URL(req.url).searchParams;
  const since = params.get("since");
  if (!since && params.get("v") !== "2") {
    // A page loaded before the wire format changed: it re-fetches the whole
    // pool on every live event and cannot read this format anyway. Its
    // error slot shows this text; a reload picks up the current script.
    return json({ v: 2, rev: "", full: true, bots: {}, items: {}, enchants: {}, catalog: [], instances: [], error: "This page is out of date — reload it to see the pool." });
  }
  if (since) {
    const body = poolDelta(snap, since);
    if (body !== null) return send(body, { gzip: gz && body.length >= GZIP_MIN_BYTES ? deltaGzip(snap, since, body) : null });
  }
  const etag = `"${snap.rev}"`;
  if (etagMatches(req.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "no-cache", Vary: "Accept-Encoding" } });
  }
  return send(fullBytes(snap), { gzip: gz ? fullGzip(snap) : null, etag });
}
