/**
 * ESM: `node --import indratrace/register app.js`.
 *
 * ESM hoists every `import`, so an initObservability() call inside app.js runs
 * after express/openai are already loaded. Loaded first, this initializes from
 * INDRATRACE_* env vars before the app (which also registers the import hook),
 * then waits (top-level await) until openai/@anthropic-ai/sdk are patched, so the
 * very first model call is traced. It does not wait for the startup preflight.
 */
import { initObservability } from "./init.js";
import { state } from "./state.js";

// A missing key throws IndraTraceConfigError here, at boot, where it will be seen.
void initObservability();
await state().aiPatched;
