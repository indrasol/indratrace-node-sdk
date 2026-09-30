import { afterEach, describe, expect, it, vi } from "vitest";
import { OTLPExporterError } from "@opentelemetry/otlp-exporter-base";
import { resolveConfig } from "../src/config.js";
import { diagnoseException, diagnoseStatus, ExportHealth, runPreflight } from "../src/preflight.js";
import { initObservability, shutdown } from "../src/init.js";
import { traceAgent } from "../src/index.js";
import { state } from "../src/state.js";
import { captureConsole, fakeGateway, KEY, type FakeGateway } from "./helpers.js";

let gw: FakeGateway | undefined;
afterEach(async () => {
  await gw?.close();
  gw = undefined;
  delete process.env.INDRATRACE_ENDPOINT;
  delete process.env.INDRATRACE_PREFLIGHT;
});

function cfgFor(url: string) {
  process.env.INDRATRACE_ENDPOINT = url;
  return resolveConfig({ apiKey: KEY });
}

describe("runPreflight against a fake gateway", () => {
  it("sends one authenticated empty POST to /v1/traces; 2xx is ok", async () => {
    gw = await fakeGateway(200, "", "application/x-protobuf");
    const d = await runPreflight(cfgFor(gw.url));
    expect(d.cause).toBe("ok");
    expect(gw.requests).toHaveLength(1);
    expect(gw.requests[0]!.path).toBe("/v1/traces");
    expect(gw.requests[0]!.headers["x-indratrace-key"]).toBe(KEY);
    expect(gw.requests[0]!.body.length).toBe(0);
  });

  it("a boot that blocks the event loop past the timeout is not reported as a network problem", async () => {
    gw = await fakeGateway(200, "", "application/x-protobuf");
    const pending = runPreflight(cfgFor(gw.url));
    const until = Date.now() + 2500; // longer than the 2 s connect window
    while (Date.now() < until) {
      // a CJS app requiring its dependencies synchronously
    }
    expect((await pending).cause).toBe("ok");
  });

  it("401 names the key, and never contains it", async () => {
    gw = await fakeGateway(401, JSON.stringify({ title: "unauthorized", detail: "invalid key" }));
    const d = await runPreflight(cfgFor(gw.url));
    expect(d.cause).toBe("unauthorized");
    expect(d.message).toContain("rejected the API key (HTTP 401: invalid key)");
    expect(d.message).not.toContain(KEY);
  });

  it("the two 402s are told apart by the problem title", async () => {
    gw = await fakeGateway(402, JSON.stringify({ title: "account suspended" }));
    expect((await runPreflight(cfgFor(gw.url))).cause).toBe("suspended");
    await gw.close();
    gw = await fakeGateway(402, JSON.stringify({ title: "no card on file" }));
    expect((await runPreflight(cfgFor(gw.url))).cause).toBe("no-card");
  });

  it("404 means something else is listening there", async () => {
    gw = await fakeGateway(404, "not found", "text/plain");
    expect((await runPreflight(cfgFor(gw.url))).cause).toBe("not-gateway");
  });

  it("a closed localhost port is refused-localhost", async () => {
    gw = await fakeGateway(200);
    const url = gw.url;
    await gw.close();
    gw = undefined;
    expect((await runPreflight(cfgFor(url))).cause).toBe("refused-localhost");
  });
});

describe("classification", () => {
  const cfg = resolveConfig({ apiKey: KEY });
  const err = (code: string, message = code) => Object.assign(new Error(message), { code });

  it.each([
    ["ENOTFOUND", "dns"],
    ["EAI_AGAIN", "dns"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "tls"],
    ["SELF_SIGNED_CERT_IN_CHAIN", "tls"],
    ["ECONNREFUSED", "refused"],
    ["IT_CONNECT_TIMEOUT", "egress-blocked"],
    ["EHOSTUNREACH", "egress-blocked"],
    ["IT_READ_TIMEOUT", "stalled"],
  ])("%s -> %s", (code, cause) => {
    expect(diagnoseException(err(code), cfg).cause).toBe(cause);
  });

  it("looks inside AggregateError (happy-eyeballs connect failures)", () => {
    const agg = Object.assign(new AggregateError([err("ECONNREFUSED")], ""), {});
    expect(diagnoseException(agg, cfg).cause).toBe("refused");
  });

  it("maps every gateway status the contract names", () => {
    expect(diagnoseStatus(429, "", cfg).cause).toBe("rate-limited");
    expect(diagnoseStatus(502, "", cfg).cause).toBe("collector-down");
    expect(diagnoseStatus(503, "", cfg).cause).toBe("control-plane-down");
    expect(diagnoseStatus(418, "", cfg).cause).toBe("unexpected");
  });

  it("redacts the key even from an unexpected error's own message", () => {
    expect(diagnoseException(new Error(`weird ${KEY}`), cfg).message).not.toContain(KEY);
  });
});

describe("ExportHealth", () => {
  const cfg = resolveConfig({ apiKey: KEY });

  it("stays quiet under the threshold, reports once, rate-limits, then logs recovery", () => {
    const out = captureConsole();
    let now = 0;
    const h = new ExportHealth(cfg, 3, 300_000, () => now);
    const e401 = new OTLPExporterError("Unauthorized", 401, JSON.stringify({ detail: "invalid key" }));
    try {
      h.recordFailure("traces", e401);
      h.recordFailure("logs", e401);
      expect(out.lines).toHaveLength(0);
      h.recordFailure("traces", e401);
      expect(out.lines).toHaveLength(1);
      expect(out.lines[0]).toMatch(/\[ERROR\] 3 consecutive export batches failed .*rejected the API key/);
      h.recordFailure("traces", e401);
      expect(out.lines).toHaveLength(1);
      now = 301_000;
      h.recordFailure("traces", e401);
      expect(out.lines[1]).toMatch(/still failing - 2 more batches dropped/);
      h.recordSuccess("traces"); // recovery is INFO: printed only with debug on
      expect(out.lines).toHaveLength(2);
    } finally {
      out.restore();
    }
  });

  it("an exporter error with no status is the egress signature", () => {
    expect(new ExportHealth(cfg).diagnose(new OTLPExporterError("Request Timeout")).cause).toBe("egress-blocked");
  });
});

describe("init through the real OTLP exporters", () => {
  it("a 401 gateway: preflight logs the diagnosis, exports carry the header, the key is never printed", async () => {
    gw = await fakeGateway(401, JSON.stringify({ title: "unauthorized", detail: "invalid key" }));
    process.env.INDRATRACE_ENDPOINT = gw.url;
    const out = captureConsole();
    try {
      await initObservability({ apiKey: KEY, debug: true });
      traceAgent("x", () => {})();
      await state().tracerProvider?.forceFlush().catch(() => {}); // OTel rejects a failed flush
      const traceExports = gw.requests.filter((r) => r.path === "/v1/traces" && r.body.length > 0);
      expect(traceExports.length).toBeGreaterThan(0);
      expect(traceExports.every((r) => r.headers["x-indratrace-key"] === KEY)).toBe(true);
      expect(traceExports.every((r) => r.headers["content-type"] === "application/x-protobuf")).toBe(true);
      const text = out.lines.join("\n");
      expect(text).toContain("IndraTrace SDK v");
      expect(text).toContain("rejected the API key");
      expect(text).toMatch(/traces export FAILED/);
      expect(text).not.toContain(KEY);
    } finally {
      await shutdown();
      out.restore();
    }
  });

  it("INDRATRACE_PREFLIGHT=strict rejects the returned promise with IndraTraceConfigError", async () => {
    gw = await fakeGateway(401, "{}");
    process.env.INDRATRACE_ENDPOINT = gw.url;
    process.env.INDRATRACE_PREFLIGHT = "strict";
    try {
      await expect(initObservability({ apiKey: KEY })).rejects.toMatchObject({ name: "IndraTraceConfigError" });
    } finally {
      await shutdown();
    }
  });

  it("a missing key throws synchronously and sets nothing up", () => {
    const saved = process.env.INDRATRACE_API_KEY;
    delete process.env.INDRATRACE_API_KEY;
    try {
      expect(() => initObservability()).toThrow(/No API key/);
      expect(state().initialized).toBe(false);
    } finally {
      if (saved !== undefined) process.env.INDRATRACE_API_KEY = saved;
    }
  });

  it("never throws at runtime when the gateway is unreachable", async () => {
    process.env.INDRATRACE_ENDPOINT = "http://127.0.0.1:1";
    const out = captureConsole();
    try {
      await initObservability({ apiKey: KEY });
      expect(() => traceAgent("x", () => {})()).not.toThrow();
    } finally {
      out.restore();
    }
    // shutdown() flushes against the dead endpoint and still never rejects.
    await expect(shutdown()).resolves.toBeUndefined();
  });
});

vi.setConfig({ testTimeout: 20_000 });
