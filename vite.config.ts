import os from "node:os";
import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  build: { outDir: "dist/client", emptyOutDir: true },
  // Tests never touch the repo's data dir (the sealing key lives there).
  test: { env: { DATA_DIR: path.join(os.tmpdir(), "rotmgtradenode-vitest-data") } },
  server: {
    port: 5173,
    // Dev: Vite serves the client, the API runs on its own port.
    proxy: { "/api": { target: `http://localhost:${process.env.PORT ?? 3000}` } },
  },
});
