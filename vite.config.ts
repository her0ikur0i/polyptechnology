import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-dashboard", emptyOutDir: true, sourcemap: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/dashboard/setup.ts"],
    include: ["tests/dashboard/**/*.test.{ts,tsx}"],
    exclude: ["dist/**", "dist-dashboard/**", "node_modules/**"],
    css: true,
  },
});
