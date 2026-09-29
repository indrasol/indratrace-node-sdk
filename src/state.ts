/**
 * Process-wide SDK state, kept on globalThis so the ESM and CJS builds share one
 * copy (`--import indratrace/register` loads ESM while app code may `require`).
 */
import { trace, type Tracer } from "@opentelemetry/api";
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { LoggerProvider } from "@opentelemetry/sdk-logs";
import type { MeterProvider } from "@opentelemetry/sdk-metrics";
import type { Instrumentation } from "@opentelemetry/instrumentation";

export interface SdkState {
  initialized: boolean;
  ready: Promise<void>;
  tracerProvider?: NodeTracerProvider;
  loggerProvider?: LoggerProvider;
  meterProvider?: MeterProvider;
  instrumentations: Instrumentation[];
  exitHookInstalled?: boolean;
  importHookRegistered?: boolean;
  /** Settles when openai/@anthropic-ai/sdk are patched (see init.patchAiSdks). */
  aiPatched: Promise<void>;
  /** Undo functions for patches that instrumentation.disable() does not reach. */
  cleanups: (() => void)[];
}

const KEY = Symbol.for("indratrace.sdk.state");
type Holder = { [KEY]?: SdkState };

export function state(): SdkState {
  const g = globalThis as Holder;
  return (g[KEY] ??= {
    initialized: false,
    ready: Promise.resolve(),
    aiPatched: Promise.resolve(),
    instrumentations: [],
    cleanups: [],
  });
}

export const INSTRUMENTATION_SCOPE = "indratrace";

/** Our provider if initialized, else the global API (non-recording spans). */
export function getTracer(): Tracer {
  return state().tracerProvider?.getTracer(INSTRUMENTATION_SCOPE) ?? trace.getTracer(INSTRUMENTATION_SCOPE);
}
