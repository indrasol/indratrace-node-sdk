import { defineConfig } from "tsup";

const common = { target: "node20", platform: "node", sourcemap: true } as const;

export default defineConfig([
  // ESM register uses top-level await, which CJS cannot, so each format gets its own register.
  { ...common, entry: { index: "src/index.ts", register: "src/register.ts" }, format: "esm", dts: { entry: { index: "src/index.ts" } }, clean: true },
  // import.meta.url shimmed for the CJS build (init.ts reads the require cache through it).
  { ...common, entry: { index: "src/index.ts", register: "src/register-cjs.ts" }, format: "cjs", dts: { entry: { index: "src/index.ts" } }, shims: true },
]);
