// The app's icons, made from public/logo.png (a 112×112 pixel-art sprite,
// RealmEye-style with an outline and a soft shadow): the Windows .ico
// (16–256 px), the Linux PNG set, the tray icon and the site's favicon.ico.
// Pixel art is scaled by whole multiples with nearest-neighbour and padded to
// size, so it stays crisp; the smaller sizes are scaled down smoothly. Run by
// scripts/desktop.mjs before packaging; the outputs are checked in as well.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const logo = path.join(root, "public", "logo.png");

/** The logo at `size` px square. */
async function render(size) {
  const meta = await sharp(logo).metadata();
  const side = Math.max(meta.width ?? 40, meta.height ?? 40);
  const k = Math.floor(size / side);
  // A size between one and two logos (128 px for a 112 px logo) pads rather
  // than stretching the pixels by an uneven factor.
  if (k >= 1) {
    // Whole multiples, nearest-neighbour, centred on a transparent square.
    const scaled = side * Math.max(1, k);
    const pad = Math.floor((size - scaled) / 2);
    const img = await sharp(logo).resize(scaled, scaled, { kernel: "nearest", fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: img, left: pad, top: pad }])
      .png()
      .toBuffer();
  }
  return sharp(logo).resize(size, size, { kernel: "lanczos3", fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
}

/** A .ico of PNG-compressed images (Windows Vista and later read these at every size). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const dir = Buffer.alloc(16 * images.length);
  let offset = header.length + dir.length;
  images.forEach(({ size, data }, i) => {
    const at = i * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2);
    dir.writeUInt8(0, at + 3);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(data.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, dir, ...images.map((i) => i.data)]);
}

const out = (...p) => path.join(root, ...p);
fs.mkdirSync(out("build", "icons"), { recursive: true });

const winSizes = [16, 24, 32, 48, 64, 128, 256];
const images = [];
for (const size of winSizes) images.push({ size, data: await render(size) });
fs.writeFileSync(out("build", "icon.ico"), ico(images));

for (const size of [16, 32, 48, 64, 128, 256, 512]) fs.writeFileSync(out("build", "icons", `${size}x${size}.png`), await render(size));
fs.writeFileSync(out("build", "icon.png"), await render(512));

// The tray: 16 px, and 32 px for high-DPI screens (Electron picks the @2x file by itself).
fs.writeFileSync(out("electron", "tray.png"), await render(16));
fs.writeFileSync(out("electron", "tray@2x.png"), await render(32));

// The site's favicon.ico, for whatever asks for it instead of the <link rel="icon"> logo.png.
const favSizes = [16, 32, 48];
const fav = [];
for (const size of favSizes) fav.push({ size, data: await render(size) });
fs.writeFileSync(out("public", "favicon.ico"), ico(fav));

console.log(`[icons] build/icon.ico (${winSizes.join(", ")} px), build/icons/*.png, electron/tray.png, public/favicon.ico`);
