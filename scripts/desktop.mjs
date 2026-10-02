// Cross-platform runner for the desktop scripts. npm scripts chained with
// ";" or "&&" behave differently under cmd.exe, and the native module has
// to be rebuilt for Electron before a run and put back for Node after it,
// whatever happened in between.
//
//   node scripts/desktop.mjs run    build, rebuild for Electron, launch, restore
//   node scripts/desktop.mjs pack   build, electron-builder --dir, restore
//   node scripts/desktop.mjs dist   build, electron-builder, restore
//
// Anything after the mode goes to electron-builder as it is, e.g.
// `node scripts/desktop.mjs dist --win --x64 --publish always` (CI).
// The packaging config is build/electron-builder.config.cjs.
import { spawnSync } from "node:child_process";

const mode = process.argv[2] ?? "run";
const extra = process.argv.slice(3);
const isWin = process.platform === "win32";
const npm = isWin ? "npm.cmd" : "npm";
const npx = isWin ? "npx.cmd" : "npx";
const config = ["--config", "build/electron-builder.config.cjs"];

function run(cmd, args) {
  console.log(`[desktop] ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: isWin });
  return r.status ?? 1;
}

let status = run(npm, ["run", "build"]);
if (status === 0) status = run(process.execPath, ["build/make-icons.mjs"]);
if (status === 0) {
  if (mode === "run") {
    status = run(npx, ["electron-builder", "install-app-deps"]);
    if (status === 0) status = run(npx, ["electron", "."]);
  } else if (mode === "pack") status = run(npx, ["electron-builder", ...config, "--dir", ...extra]);
  else if (mode === "dist") status = run(npx, ["electron-builder", ...config, ...extra]);
  else {
    console.error(`unknown mode ${mode}`);
    status = 2;
  }
}
// Always put the Node build back so npm start / npm test keep working.
const restore = run(npm, ["rebuild", "better-sqlite3"]);
process.exit(status || restore);
