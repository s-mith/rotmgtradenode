import { gzipSync } from "node:zlib";
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { clientIp } from "@/lib/ratelimit";
import { sessionFromRequest } from "@/lib/session";
import { recordTraffic, visitorKey } from "@/lib/traffic";
import { acceptsGzip } from "./http";
import { registerRoutes } from "./routes";

const CLIENT_DIR = process.env.CLIENT_DIR ?? "./dist/client";
/** Smaller JSON bodies are not worth a gzip header. */
const GZIP_MIN_BYTES = 1024;

export function createApp(): Hono {
  const app = new Hono();

  // Who got how many bytes, per route (lib/traffic.ts). Outermost so it sees
  // the response as it leaves — after the gzip below, with the Content-Length
  // every JSON route and the pool ends up carrying. A stream (/api/live) has
  // no length and counts as a request only.
  app.use("/api/*", async (c, next) => {
    await next();
    try {
      const s = sessionFromRequest(c.req.raw);
      const bytes = Number(c.res.headers.get("Content-Length")) || 0;
      // Unmatched paths share one bucket rather than a row per guess, so a
      // scanner can't grow the table with the paths it tries.
      const route = c.req.routePath && c.req.routePath !== "/api/*" ? c.req.routePath : "(no such route)";
      recordTraffic(visitorKey(s?.ignLower ?? null, clientIp(c.req.raw)), route, bytes);
    } catch {
      // Accounting must never break a response.
    }
  });

  // Compress JSON API responses here, in the process. Railway meters the bytes
  // that leave the container, so the gzip its edge applies on the way to the
  // browser saves nothing on the bill; this does. Streams (/api/live sets
  // no-transform) and responses that arrive already encoded (/api/pool serves
  // a cached gzip) pass through untouched. Bodies are buffered, which is fine:
  // every JSON route answers in one piece and the big one is pre-encoded.
  app.use("/api/*", async (c, next) => {
    await next();
    const res = c.res;
    if (res.status !== 200 || !res.body || res.headers.has("Content-Encoding")) return;
    if (!/^application\/json/i.test(res.headers.get("Content-Type") ?? "")) return;
    if (/no-transform/i.test(res.headers.get("Cache-Control") ?? "")) return;
    // Buffered either way, so every JSON response leaves with its length:
    // the accounting above reads it, and a client that doesn't take gzip
    // gets a plain body with a Content-Length instead of a chunked one.
    const body = Buffer.from(await res.arrayBuffer());
    const headers = new Headers(res.headers);
    if (body.length < GZIP_MIN_BYTES || !acceptsGzip(c.req.header("Accept-Encoding"))) {
      headers.set("Content-Length", String(body.length));
      c.res = new Response(body, { status: res.status, headers });
      return;
    }
    const gz = gzipSync(body, { level: 5 });
    headers.set("Content-Encoding", "gzip");
    headers.set("Content-Length", String(gz.length));
    headers.append("Vary", "Accept-Encoding");
    c.res = new Response(gz, { status: res.status, headers });
  });

  // API. Every handler under src/server/api registers here.
  registerRoutes(app);
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

  // Built client. Hashed assets can be cached hard; index.html must not be,
  // or a deploy leaves browsers holding a page that points at assets that no
  // longer exist. `precompressed` serves the .br/.gz twins the build writes
  // (scripts/precompress.mjs) to browsers that accept them.
  app.use(
    "/assets/*",
    serveStatic({
      root: CLIENT_DIR,
      precompressed: true,
      onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
    }),
  );
  app.use("/*", serveStatic({ root: CLIENT_DIR, precompressed: true }));
  app.get("*", async (c, next) => {
    // SPA fallback: any GET that isn't a file is a client route.
    c.header("Cache-Control", "no-cache");
    return serveStatic({ root: CLIENT_DIR, path: "index.html" })(c, next);
  });

  app.onError((err, c) => {
    console.error(`[http] ${c.req.method} ${c.req.path}:`, err);
    return c.json({ error: "Internal error" }, 500);
  });

  return app;
}
