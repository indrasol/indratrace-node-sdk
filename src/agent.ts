/**
 * traceAgent / traceTool / traceStep, plus the recordLlmUsage fallback.
 *
 * Wrapper functions, not decorators: TS decorators only apply to class members,
 * and agent code is mostly plain functions. Two rules:
 *  1. Transparent - the wrapper returns and throws exactly what the function does;
 *     an error is recorded on the span (status ERROR) and re-thrown unchanged.
 *  2. Never throw from instrumentation - if a span cannot be started, the
 *     function still runs, untraced.
 */
import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import { SPAN_KIND_ATTRIBUTE } from "./context.js";
import { errorText, log } from "./log.js";
import { getTracer } from "./state.js";

type AnyFn = (...args: any[]) => any;

function fail(span: Span, err: unknown): void {
  try {
    span.recordException(err instanceof Error ? err : String(err));
    span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
  } catch {
    // recording is best-effort
  }
}

function instrument<F extends AnyFn>(fn: F, spanName: string, attributes: Record<string, string>): F {
  const wrapped = function (this: unknown, ...args: unknown[]) {
    let span: Span;
    try {
      span = getTracer().startSpan(spanName, { attributes });
    } catch (err) {
      log.debug(`could not start span '${spanName}': ${errorText(err)}`);
      return fn.apply(this, args);
    }
    return context.with(trace.setSpan(context.active(), span), () => {
      let result: unknown;
      try {
        result = fn.apply(this, args);
      } catch (err) {
        fail(span, err);
        span.end();
        throw err;
      }
      if (result && typeof (result as PromiseLike<unknown>).then === "function") {
        return (result as PromiseLike<unknown>).then(
          (value) => {
            span.end();
            return value;
          },
          (err: unknown) => {
            fail(span, err);
            span.end();
            throw err;
          },
        );
      }
      span.end();
      return result;
    });
  };
  Object.defineProperty(wrapped, "name", { value: fn.name });
  return wrapped as F;
}

function nameOf(fn: AnyFn): string {
  return fn.name || "anonymous";
}

/** A span `agent <name>` around a whole agent request. */
export function traceAgent<F extends AnyFn>(name: string, fn: F): F {
  return instrument(fn, `agent ${name}`, { [SPAN_KIND_ATTRIBUTE]: "agent", "agent.name": name });
}

/** A span `tool <name>` per tool call. The name defaults to the function's name. */
export function traceTool<F extends AnyFn>(fn: F): F;
export function traceTool<F extends AnyFn>(name: string, fn: F): F;
export function traceTool<F extends AnyFn>(a: string | F, b?: F): F {
  const [name, fn] = typeof a === "string" ? [a, b as F] : [nameOf(a), a];
  return instrument(fn, `tool ${name}`, { [SPAN_KIND_ATTRIBUTE]: "tool", "tool.name": name });
}

/** A span `step <name>` for plain, non-AI work (a query, a parser) that is not a "tool". */
export function traceStep<F extends AnyFn>(fn: F): F;
export function traceStep<F extends AnyFn>(name: string, fn: F): F;
export function traceStep<F extends AnyFn>(a: string | F, b?: F): F {
  const [name, fn] = typeof a === "string" ? [a, b as F] : [nameOf(a), a];
  return instrument(fn, `step ${name}`, { [SPAN_KIND_ATTRIBUTE]: "step", "step.name": name });
}

export interface LlmUsageOptions {
  /** The provider, e.g. "anthropic", "openai". Stamped as gen_ai.provider.name. */
  system?: string;
  /** Extra attributes stamped verbatim, e.g. cache token counts. */
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Stamp gen_ai.* usage on the CURRENT span, for providers we do not
 * auto-instrument. Same names as the auto path, raw counts only, never cost.
 * A silent no-op outside a recording span.
 */
export function recordLlmUsage(
  model: string,
  inputTokens: number,
  outputTokens: number,
  options: LlmUsageOptions = {},
): void {
  try {
    const span = trace.getActiveSpan();
    if (!span || !span.isRecording()) {
      log.debug("recordLlmUsage called with no recording span; attributes dropped (is it inside traceAgent/traceTool?)");
      return;
    }
    span.setAttributes({
      "gen_ai.provider.name": options.system ?? "other",
      "gen_ai.request.model": model,
      "gen_ai.usage.input_tokens": Math.trunc(inputTokens),
      "gen_ai.usage.output_tokens": Math.trunc(outputTokens),
      ...options.attributes,
    });
  } catch (err) {
    log.debug(`recordLlmUsage failed: ${errorText(err)}`);
  }
}
