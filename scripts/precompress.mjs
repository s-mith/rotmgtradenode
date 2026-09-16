// Write .gz and .br twins beside every compressible file in the built client
// so serveStatic({ precompressed: true }) can hand browsers the small copy.
// Railway meters the bytes leaving the container; its edge would gzip these
// on the way out, but that does not shrink the metered volume.
import { promises as fs } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const root = process.argv[2] ?? "dist/client";
const COMPRESSIBLE = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt", ".xml", ".webmanifest"]);
const MIN_BYTES = 1024;

async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(p);
    else yield p;
  }
}

let files = 0;
let before = 0;
let afterGz = 0;
let afterBr = 0;
for await (const file of walk(root)) {
  if (!COMPRESSIBLE.has(path.extname(file))) continue;
  const data = await fs.readFile(file);
  if (data.length < MIN_BYTES) continue;
  const gz = zlib.gzipSync(data, { level: 9 });
  const br = zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  await fs.writeFile(`${file}.gz`, gz);
  await fs.writeFile(`${file}.br`, br);
  files++;
  before += data.length;
  afterGz += gz.length;
  afterBr += br.length;
}
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`precompress: ${files} file(s), ${kb(before)} -> gzip ${kb(afterGz)}, brotli ${kb(afterBr)}`);
