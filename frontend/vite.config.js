import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The React app talks to the EXISTING backend exclusively through relative
// "/api/..." paths (see src/api.js) so it can be deployed on the same origin
// as the backend with zero config. For local development, where Vite runs on
// its own port, we proxy those same "/api/..." paths through to wherever the
// existing backend is actually running so cookies/CSRF continue to work
// exactly as they did with the old single-page HTML app.
//
// Point this at your real backend dev server, e.g.:
//   VITE_API_PROXY_TARGET=http://localhost:3000 npm run dev
const backendTarget = process.env.VITE_API_PROXY_TARGET || "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: backendTarget,
        changeOrigin: true,
        secure: false,
      },
    },
  },
  build: {
    outDir: "dist",
  },
});
