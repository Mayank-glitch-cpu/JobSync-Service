import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, proxy API calls to the local mcp-server (default :3000) so the SPA and
// API share an origin like they do in production.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: process.env.JOBSYNC_API_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
