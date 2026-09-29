import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildResource,
  DEFAULT_ENDPOINT,
  GATEWAY_STAMPED_ATTRS,
  IndraTraceConfigError,
  MISSING_API_KEY_MESSAGE,
  plaintextEndpointWarning,
  redactApiKey,
  redactUrlCredentials,
  resolveConfig,
  resolveFlag,
  resolvePreflightMode,
  signalUrl,
} from "../src/config.js";
import { VERSION } from "../src/version.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(VERSION).toBe(pkg.version);
  });
});

describe("resolveConfig", () => {
  it("throws IndraTraceConfigError with the actionable message when there is no key", () => {
    delete process.env.INDRATRACE_API_KEY;
    expect(() => resolveConfig()).toThrow(IndraTraceConfigError);
    expect(() => resolveConfig({ apiKey: "" })).toThrow(MISSING_API_KEY_MESSAGE);
  });

  it("falls back to INDRATRACE_API_KEY, and the option wins over it", () => {
    process.env.INDRATRACE_API_KEY = "from-env";
    expect(resolveConfig().apiKey).toBe("from-env");
    expect(resolveConfig({ apiKey: "from-arg" }).apiKey).toBe("from-arg");
  });

  it("uses the production gateway unless INDRATRACE_ENDPOINT overrides it", () => {
    delete process.env.INDRATRACE_ENDPOINT;
    const cfg = resolveConfig({ apiKey: "k" });
    expect(cfg.endpoint).toBe(DEFAULT_ENDPOINT);
    expect(cfg.endpointSource).toBe("default");
    expect(signalUrl(cfg, "traces")).toBe("https://ingest.indratrace.com/v1/traces");

    process.env.INDRATRACE_ENDPOINT = "http://localhost:8088/";
    const dev = resolveConfig({ apiKey: "k" });
    expect(dev.endpointSource).toBe("env");
    expect(signalUrl(dev, "logs")).toBe("http://localhost:8088/v1/logs");
  });
});

describe("buildResource", () => {
  it("carries the wrapper and service labels, and none of the gateway-stamped attributes", () => {
    // Even when the environment tries to inject them.
    process.env.OTEL_RESOURCE_ATTRIBUTES = "product=spoof,deployment.environment=prod,tenant.id=evil,team=core";
    const r = buildResource(resolveConfig({ apiKey: "k", serviceName: "checkout-api", serviceVersion: "1.2.3" }));
    expect(r.attributes["telemetry.sdk.wrapper"]).toBe(`indratrace-js/${VERSION}`);
    expect(r.attributes["service.name"]).toBe("checkout-api");
    expect(r.attributes["service.version"]).toBe("1.2.3");
    expect(r.attributes["team"]).toBe("core");
    for (const k of GATEWAY_STAMPED_ATTRS) expect(r.attributes).not.toHaveProperty(k);
  });

  it("leaves service.name to OpenTelemetry when not given", () => {
    process.env.OTEL_SERVICE_NAME = "from-otel-env";
    const r = buildResource(resolveConfig({ apiKey: "k" }));
    expect(r.attributes["service.name"]).toBe("from-otel-env");
    expect(r.attributes["service.version"]).toBe("0.0.0");
  });
});

describe("flags", () => {
  it("explicit > env truthy set > false", () => {
    delete process.env.INDRATRACE_DEBUG;
    expect(resolveFlag(undefined, "INDRATRACE_DEBUG")).toBe(false);
    for (const v of ["1", "true", "YES", " on "]) {
      process.env.INDRATRACE_DEBUG = v;
      expect(resolveFlag(undefined, "INDRATRACE_DEBUG")).toBe(true);
    }
    process.env.INDRATRACE_DEBUG = "nope";
    expect(resolveFlag(undefined, "INDRATRACE_DEBUG")).toBe(false);
    expect(resolveFlag(true, "INDRATRACE_DEBUG")).toBe(true);
  });

  it("preflight mode: warn by default, off, strict", () => {
    delete process.env.INDRATRACE_PREFLIGHT;
    expect(resolvePreflightMode()).toBe("warn");
    process.env.INDRATRACE_PREFLIGHT = "0";
    expect(resolvePreflightMode()).toBe("off");
    process.env.INDRATRACE_PREFLIGHT = "STRICT";
    expect(resolvePreflightMode()).toBe("strict");
  });
});

describe("redaction and transport warnings", () => {
  it("redacts the key in all the forms an error can print it", () => {
    const key = "it_live_abc\n";
    expect(redactApiKey(`bad header "it_live_abc\\n" and it_live_abc`, key)).not.toContain("it_live_abc");
  });

  it("does not shred ordinary words when the key is implausibly short", () => {
    expect(redactApiKey("egress is blocked", "k")).toBe("egress is blocked");
  });

  it("hides URL credentials", () => {
    expect(redactUrlCredentials("to https://user:pass@gw.example.com/v1")).toBe("to https://***@gw.example.com/v1");
  });

  it("warns on plain http to another host, not on https or loopback", () => {
    expect(plaintextEndpointWarning("http://gw.internal:8088")).toMatch(/unencrypted/);
    expect(plaintextEndpointWarning("https://gw.internal")).toBeUndefined();
    expect(plaintextEndpointWarning("http://localhost:8088")).toBeUndefined();
    expect(plaintextEndpointWarning("http://127.0.0.1:8088")).toBeUndefined();
  });
});
