/**
 * Session/user context and the feedback API. Port of the Python SDK's `context.py`.
 *
 * `session()` puts the ids into OTel baggage; `SessionSpanProcessor` copies them
 * onto every span at start - decorator spans, HTTP spans and model spans alike.
 * Session and user ids are span attributes only, never resource attributes or
 * metric labels (unbounded cardinality).
 */
import { context, isSpanContextValid, propagation, trace, type Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { log, errorText } from "./log.js";
import { getTracer } from "./state.js";

export const SESSION_ID_KEY = "session.id";
export const USER_ID_KEY = "user.id";
export const SPAN_KIND_ATTRIBUTE = "indratrace.span.kind";

export class SessionSpanProcessor implements SpanProcessor {
  onStart(span: Span, parentContext: Context): void {
    try {
      const bag = propagation.getBaggage(parentContext);
      const sessionId = bag?.getEntry(SESSION_ID_KEY)?.value;
      if (sessionId !== undefined) span.setAttribute(SESSION_ID_KEY, sessionId);
      const userId = bag?.getEntry(USER_ID_KEY)?.value;
      if (userId !== undefined) span.setAttribute(USER_ID_KEY, userId);
    } catch (err) {
      log.debug(`SessionSpanProcessor.onStart failed: ${errorText(err)}`);
    }
  }
  onEnd(_span: ReadableSpan): void {}
  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

export interface SessionIds {
  sessionId?: string;
  userId?: string;
}

/**
 * Run `fn` with `session.id` / `user.id` on every span it starts, sync or async.
 * Returns whatever `fn` returns. Nesting overrides per key. Inert (just runs
 * `fn`) before `initObservability`.
 *
 *   app.use((req, res, next) => session({ sessionId: req.get("x-session-id") }, next));
 */
export function session<T>(ids: SessionIds, fn: () => T): T {
  let ctx: Context;
  try {
    const active = context.active();
    let bag = propagation.getBaggage(active) ?? propagation.createBaggage();
    if (ids.sessionId != null) bag = bag.setEntry(SESSION_ID_KEY, { value: String(ids.sessionId) });
    if (ids.userId != null) bag = bag.setEntry(USER_ID_KEY, { value: String(ids.userId) });
    ctx = propagation.setBaggage(active, bag);
  } catch (err) {
    log.debug(`session() failed: ${errorText(err)}`);
    return fn();
  }
  return context.with(ctx, fn);
}

/** The current trace id (32-char lowercase hex), or undefined outside a span. */
export function currentTraceId(): string | undefined {
  try {
    const sc = trace.getActiveSpan()?.spanContext();
    return sc && isSpanContextValid(sc) ? sc.traceId : undefined;
  } catch {
    return undefined;
  }
}

export interface FeedbackOptions {
  comment?: string;
  /** The trace this is about (what `currentTraceId()` returned). Defaults to the current trace. */
  traceId?: string;
}

/**
 * Emit a `feedback` span tying a score (1 = positive, 0/-1 = negative, or any
 * numeric scale) to a trace. With no trace id at all the span is still emitted:
 * losing the score is worse than a span with no link.
 */
export function recordFeedback(score: number, options: FeedbackOptions = {}): void {
  try {
    const linked = options.traceId ?? currentTraceId();
    if (linked === undefined) log.debug("recordFeedback has no traceId and no current trace; emitting an unlinked feedback span");
    const attributes: Record<string, string | number> = {
      [SPAN_KIND_ATTRIBUTE]: "feedback",
      "feedback.score": score,
    };
    if (options.comment !== undefined) attributes["feedback.comment"] = options.comment;
    if (linked !== undefined) attributes["feedback.trace_id"] = linked;
    getTracer().startSpan("feedback", { attributes }).end();
  } catch (err) {
    log.debug(`recordFeedback failed: ${errorText(err)}`);
  }
}
