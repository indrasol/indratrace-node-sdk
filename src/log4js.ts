/**
 * log4js -> OpenTelemetry logs. There is no official instrumentation for log4js,
 * so this is a small one in the same shape as the pino/winston/bunyan ones: every
 * logged event becomes a log record carrying the active trace context.
 *
 * It hooks the internal `lib/logger.js` file, where `Logger.prototype._log` runs
 * only for events whose level is enabled, and before any appender sees them.
 */
import { format } from "node:util";
import { context } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
} from "@opentelemetry/instrumentation";
import { VERSION } from "./version.js";

const SUPPORTED = [">=6 <7"];
const NAME = "indratrace-log4js";

const SEVERITY: Record<string, SeverityNumber> = {
  TRACE: SeverityNumber.TRACE,
  DEBUG: SeverityNumber.DEBUG,
  INFO: SeverityNumber.INFO,
  WARN: SeverityNumber.WARN,
  ERROR: SeverityNumber.ERROR,
  FATAL: SeverityNumber.FATAL,
  MARK: SeverityNumber.INFO,
};

type Log = (this: { category?: string }, level: { levelStr?: string }, data: unknown[]) => unknown;

export class Log4jsInstrumentation extends InstrumentationBase {
  /**
   * `quiet()` silences console capture while log4js dispatches the event, and returns
   * the function that restores it: log4js's "console" appender prints through
   * console.log, and that line must not arrive a second time.
   */
  constructor(private readonly quiet: () => () => void) {
    super(NAME, VERSION, {});
  }

  protected init() {
    return new InstrumentationNodeModuleDefinition("log4js", SUPPORTED, (m) => m, (m) => m, [
      new InstrumentationNodeModuleFile(
        "log4js/lib/logger.js",
        SUPPORTED,
        (Logger: { prototype: { _log: Log } }) => {
          this._wrap(Logger.prototype, "_log", (original: Log) => this.patched(original));
          return Logger;
        },
        (Logger?: { prototype: { _log: Log } }) => {
          if (Logger) this._unwrap(Logger.prototype, "_log");
        },
      ),
    ]);
  }

  private patched(original: Log): Log {
    const quiet = this.quiet;
    return function (this: { category?: string }, level, data) {
      try {
        const levelStr = level?.levelStr ?? "INFO";
        logs.getLogger(NAME, VERSION).emit({
          severityNumber: SEVERITY[levelStr] ?? SeverityNumber.INFO,
          severityText: levelStr,
          body: format(...(Array.isArray(data) ? data : [data])),
          attributes: this.category ? { "log4js.category": this.category } : undefined,
          context: context.active(),
        });
      } catch {
        // never break the app's logging
      }
      const restore = quiet();
      try {
        return original.call(this, level, data);
      } finally {
        restore();
      }
    };
  }
}
