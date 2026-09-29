/**
 * The SDK's own diagnostics, on stderr. Warnings and errors always print (like
 * Python's logging with no handler configured); debug and info only with
 * `debug: true` / `INDRATRACE_DEBUG`. Every line goes through key redaction here,
 * once, so no caller can leak the key by accident.
 *
 * Deliberately console, not pino/winston: those are instrumented and shipped, and
 * shipping the SDK's own export errors would be a loop that feeds itself.
 */
import { redactApiKey, redactUrlCredentials } from "./config.js";

let debugOn = false;
let secret: string | undefined;

function line(level: string, message: string): string {
  return `indratrace [${level}] ${redactApiKey(redactUrlCredentials(message), secret)}`;
}

export const log = {
  configure(opts: { debug: boolean; apiKey?: string }): void {
    debugOn = opts.debug;
    secret = opts.apiKey;
  },
  get debugEnabled(): boolean {
    return debugOn;
  },
  debug(message: string): void {
    if (debugOn) console.error(line("DEBUG", message));
  },
  info(message: string): void {
    if (debugOn) console.error(line("INFO", message));
  },
  warn(message: string): void {
    console.warn(line("WARNING", message));
  },
  error(message: string): void {
    console.error(line("ERROR", message));
  },
};

export function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
