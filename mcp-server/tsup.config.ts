import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  // Preserve `node:` prefix on built-in imports — otherwise Node can't
  // resolve `node:sqlite` when written as bare `sqlite`.
  platform: "node",
  // Preserve `node:` prefix on built-in imports — otherwise Node can't
  // resolve `node:sqlite` when written as bare `sqlite`.
  external: ["node:sqlite"],
});
