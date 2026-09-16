import atlas from "@/lib/sprite-atlas.json";

// Renders one item sprite from the packed spritesheet (public/sprites/…png)
// instead of an inlined base64 PNG. The sheet downloads once (content-hashed,
// cached) and every tile is a CSS background-position into it — so /api/pool
// no longer has to ship ~1.15 KB of base64 per item on every poll.
//
// Percentage background-size/position => resolution-independent: the element's
// box (via `className` CSS or `size`) decides the rendered size; one sheet cell
// fills it exactly with no distortion (sprites and tiles are both square).

const index = atlas.index as Record<string, number>;

// Same normalization as src/lib/sprites.ts, so catalog tiles and pool
// instances (which resolve to catalog names) both hit the atlas.
const norm = (n: string) => n.replace(/^(UT|ST|T\d+)\.\s+/, "").toLowerCase().trim();

// 3-letter fallback, identical to the old base64 path — covers the handful of
// catalog items with no sprite (and any pre-atlas cached client hitting a
// sprite-less API response).
function fallbackText(name: string): string {
  return name.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase();
}

export function ItemSprite({
  name,
  className = "pool-tile-sprite",
  fallbackClassName = "pool-tile-fallback",
  size,
}: {
  name: string;
  className?: string;
  fallbackClassName?: string;
  size?: number;
}) {
  const i = index[norm(name)];
  if (i == null) {
    return <span className={fallbackClassName}>{fallbackText(name)}</span>;
  }
  const col = i % atlas.cols;
  const row = Math.floor(i / atlas.cols);
  const x = atlas.cols > 1 ? (col / (atlas.cols - 1)) * 100 : 0;
  const y = atlas.rows > 1 ? (row / (atlas.rows - 1)) * 100 : 0;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: "inline-block",
        ...(size != null ? { width: size, height: size } : null),
        backgroundImage: `url(${atlas.file})`,
        backgroundPosition: `${x}% ${y}%`,
        backgroundSize: `${atlas.cols * 100}% ${atlas.rows * 100}%`,
        backgroundRepeat: "no-repeat",
        imageRendering: "pixelated",
      }}
    />
  );
}
