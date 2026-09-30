/**
 * `node --import indratrace/register app.js` (ES modules) or
 * `node --require indratrace/register app.js` (CommonJS).
 *
 * ESM hoists every `import`, so an initObservability() call inside app.js runs
 * after express/openai are already loaded. Loaded first, this initializes from
 * INDRATRACE_* env vars before any of the app's modules load.
 */
import { initObservability } from "./init.js";

// A missing key throws IndraTraceConfigError here, at boot, where it will be seen.
void initObservability();
