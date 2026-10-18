import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Relative asset paths: the backend serves the panel under /admin behind any prefix and adds a <base>.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  // No data: URIs: the CSP allows fonts and images from the panel itself only.
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1200, assetsInlineLimit: 0 },
  server: {
    // `bun run dev` here, the backend on 3000: the dev server passes the API through.
    proxy: { "/api": "http://localhost:3000" },
  },
});
