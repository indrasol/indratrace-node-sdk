/** CommonJS: `node --require indratrace/register app.js`. Initializes from INDRATRACE_* env vars. */
import { initObservability } from "./init.js";

// A missing key throws IndraTraceConfigError here, at boot, where it will be seen.
void initObservability();
