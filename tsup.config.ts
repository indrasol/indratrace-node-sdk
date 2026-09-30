import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/register.ts"],
  format: ["esm", "cjs"],
  dts: { entry: "src/index.ts" },
  target: "node20",
  platform: "node",
  // import.meta.url in the CJS build (init.ts uses it for the loader hook and the require cache).
  shims: true,
  clean: true,
  sourcemap: true,
});
