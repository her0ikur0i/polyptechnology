import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  // sourcemap stays off: the Control API serves dist-dashboard/ as the SPA
  // (src/control-api/app.ts), so emitting maps published the dashboard's full
  // original source to anyone who could load the page -- 1.47 MB of it against
  // a 289 KB bundle. Harmless while staging is loopback-bound, unacceptable
  // once the public hostname cutover happens (CONTRACT-015 M3).
  build: { outDir: "dist-dashboard", emptyOutDir: true, sourcemap: false },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/dashboard/setup.ts"],
    include: ["tests/dashboard/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "dist-dashboard/**", "node_modules/**"],
    css: true,
  },
});
