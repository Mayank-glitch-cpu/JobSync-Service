import { defineConfig } from "tsup";
import pkg from "./package.json" assert { type: "json" };

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts", "src/http.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  platform: "node",
  external: ["node:sqlite"],
  define: {
    __JOBSYNC_VERSION__: JSON.stringify(pkg.version),
  },
});
