import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [tailwindcss()],
  base: "/studio/",
  build: {
    outDir: path.resolve(here, "../public/studio"),
    emptyOutDir: true,
    sourcemap: false
  }
});
