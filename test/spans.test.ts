import { context, propagation, SpanStatusCode } from "@opentelemetry/api";
import { afterEach, describe, expect, it } from "vitest";
import {
  currentTraceId,
  initObservability,
  recordFeedback,
  recordLlmUsage,
  session,
  traceAgent,
  traceStep,
  traceTool,
} from "../src/index.js";
import { GATEWAY_STAMPED_ATTRS } from "../src/config.js";
import { initInMemory, reset } from "./helpers.js";

afterEach(reset);

const byName = <T extends { name: string }>(spans: T[], name: string) => spans.find((s) => s.name === name);

describe("span conventions", () => {
  it("agent, tool and step spans have the contract's names and attributes, nested in one trace", async () => {
    const t = await initInMemory();
    const lookup = traceStep(function parseVendor(v: string) {
      return v.trim();
    });
    const riskScore = traceTool(async function riskScore(vendor: string) {
      return lookup(vendor).length;
    });
    const run = traceAgent("compliance-checker", async (q: string) => riskScore(q));

    expect(await run(" acme ")).toBe(4);
    const spans = await t.finished();
    const agent = byName(spans, "agent compliance-checker")!;
    const tool = byName(spans, "tool riskScore")!;
    const step = byName(spans, "step parseVendor")!;
    expect(agent.attributes).toMatchObject({ "indratrace.span.kind": "agent", "agent.name": "compliance-checker" });
    expect(tool.attributes).toMatchObject({ "indratrace.span.kind": "tool", "tool.name": "riskScore" });
    expect(step.attributes).toMatchObject({ "indratrace.span.kind": "step", "step.name": "parseVendor" });
    expect(tool.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(step.parentSpanContext?.spanId).toBe(tool.spanContext().spanId);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
  });

  it("traceTool/traceStep accept an explicit name", async () => {
    const t = await initInMemory();
    traceTool("search", () => 1)();
    traceStep("db.query", () => 2)();
    const spans = await t.finished();
    expect(byName(spans, "tool search")?.attributes["tool.name"]).toBe("search");
    expect(byName(spans, "step db.query")?.attributes["step.name"]).toBe("db.query");
  });

  it("records errors (sync and async), sets ERROR, and re-throws the SAME error", async () => {
    const t = await initInMemory();
    const boom = new TypeError("boom");
    const syncFail = traceTool(function syncFail() {
      throw boom;
    });
    const asyncFail = traceTool(async function asyncFail() {
      throw boom;
    });
    expect(() => syncFail()).toThrow(boom);
    await expect(asyncFail()).rejects.toBe(boom);
    for (const s of await t.finished()) {
      expect(s.status.code).toBe(SpanStatusCode.ERROR);
      expect(s.events.some((e) => e.name === "exception")).toBe(true);
    }
  });

  it("keeps `this` and the function name", async () => {
    await initInMemory();
    const obj = { n: 41, inc: traceTool(function inc(this: { n: number }) { return this.n + 1; }) };
    expect(obj.inc()).toBe(42);
    expect(obj.inc.name).toBe("inc");
  });

  it("wrappers and helpers work, untraced, when init never ran", async () => {
    const f = traceAgent("x", (a: number) => a * 2);
    expect(f(21)).toBe(42);
    expect(currentTraceId()).toBeUndefined();
    expect(() => recordFeedback(1)).not.toThrow();
    expect(session({ sessionId: "s" }, () => "ran")).toBe("ran");
  });

  it("a second initObservability() is a no-op", async () => {
    const t = await initInMemory();
    await initObservability({ apiKey: "other" });
    traceTool(() => 1)();
    expect(await t.finished()).toHaveLength(1);
  });
});

describe("session / user", () => {
  it("stamps session.id and user.id on every span inside, across await, with per-key nesting", async () => {
    const t = await initInMemory();
    const inner = traceTool(async function inner() {
      await new Promise((r) => setTimeout(r, 5));
    });
    await session({ sessionId: "conv-42", userId: "u1" }, async () => {
      await traceAgent("a", inner)();
      await session({ userId: "u2" }, () => inner());
    });
    traceTool(function outside() {})();

    const spans = await t.finished();
    const nested = spans.filter((s) => s.name === "tool inner");
    expect(byName(spans, "agent a")?.attributes).toMatchObject({ "session.id": "conv-42", "user.id": "u1" });
    expect(nested[0]?.attributes).toMatchObject({ "session.id": "conv-42", "user.id": "u1" });
    expect(nested[1]?.attributes).toMatchObject({ "session.id": "conv-42", "user.id": "u2" });
    expect(byName(spans, "tool outside")?.attributes).not.toHaveProperty("session.id");
  });

  it("never propagates session/user ids to outbound calls (no baggage header)", async () => {
    await initInMemory();
    const carrier: Record<string, string> = {};
    await session({ sessionId: "s", userId: "u" }, () =>
      traceTool(function call() {
        propagation.inject(context.active(), carrier);
      })(),
    );
    expect(carrier).toHaveProperty("traceparent");
    expect(carrier).not.toHaveProperty("baggage");
  });
});

describe("feedback and llm usage", () => {
  it("feedback links to the explicit trace id, else the current one", async () => {
    const t = await initInMemory();
    let captured: string | undefined;
    traceAgent("answer", () => {
      captured = currentTraceId();
      recordFeedback(1);
    })();
    recordFeedback(-1, { comment: "wrong", traceId: captured });
    recordFeedback(0);
    const fb = (await t.finished()).filter((s) => s.name === "feedback");
    expect(captured).toMatch(/^[0-9a-f]{32}$/);
    expect(fb[0]?.attributes).toMatchObject({ "indratrace.span.kind": "feedback", "feedback.score": 1, "feedback.trace_id": captured });
    expect(fb[1]?.attributes).toMatchObject({ "feedback.score": -1, "feedback.comment": "wrong", "feedback.trace_id": captured });
    expect(fb[2]?.attributes).not.toHaveProperty("feedback.trace_id");
  });

  it("recordLlmUsage stamps the same gen_ai.* names as the auto path, and no cost", async () => {
    const t = await initInMemory();
    traceTool(function callModel() {
      recordLlmUsage("mistral-large", 120, 30, { system: "mistral", attributes: { "gen_ai.usage.cache_read.input_tokens": 7 } });
    })();
    const attrs = (await t.finished())[0]!.attributes;
    expect(attrs).toMatchObject({
      "gen_ai.provider.name": "mistral",
      "gen_ai.request.model": "mistral-large",
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 30,
      "gen_ai.usage.cache_read.input_tokens": 7,
    });
    expect(Object.keys(attrs).some((k) => /cost/i.test(k))).toBe(false);
  });

  it("recordLlmUsage outside a span is a silent no-op", async () => {
    await initInMemory();
    expect(() => recordLlmUsage("m", 1, 1)).not.toThrow();
  });

  it("no span carries a gateway-stamped attribute", async () => {
    const t = await initInMemory();
    traceAgent("a", () => {})();
    for (const s of await t.finished()) {
      for (const k of GATEWAY_STAMPED_ATTRS) {
        expect(s.attributes).not.toHaveProperty(k);
        expect(s.resource.attributes).not.toHaveProperty(k);
      }
    }
  });
});
