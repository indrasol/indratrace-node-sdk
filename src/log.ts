/**
 * The SDK's own diagnostics, on stderr. Warnings and errors always print (like
 * any logger with no handler configured); debug and info only with
 * `debug: true` / `INDRATRACE_DEBUG`. Every line goes through key redaction here,
 * once, so no caller can leak the key by accident.
 *
 * Written straight to stderr, never through console or a logging library: those are
 * captured and shipped, and shipping the SDK's own export errors would be a loop
 * that feeds itself.
 */
import { redactApiKey, redactUrlCredentials } from "./config.js";

let debugOn = false;
let secret: string | undefined;

function write(level: string, message: string): void {
  try {
    process.stderr.write(`indratrace [${level}] ${redactApiKey(redactUrlCredentials(message), secret)}\n`);
  } catch {
    // a closed stderr must not break the app
  }
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
    if (debugOn) write("DEBUG", message);
  },
  info(message: string): void {
    if (debugOn) write("INFO", message);
  },
  warn(message: string): void {
    write("WARNING", message);
  },
  error(message: string): void {
    write("ERROR", message);
  },
};

export function errorText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
