import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  appPackageVersion,
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
  resolveServiceVersion,
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
  });
});

describe("resolveServiceVersion - first answer wins: option, env, package.json, 0.0.0", () => {
  // A throwaway app tree:  <root>/app/package.json (version 2.3.4) + app/src/server.js,
  // <root>/bare/package.json (no version), <root>/app/node_modules/tool/cli.js.
  const root = mkdtempSync(join(tmpdir(), "it-version-"));
  const app = join(root, "app");
  mkdirSync(join(app, "src"), { recursive: true });
  mkdirSync(join(app, "node_modules", "tool"), { recursive: true });
  mkdirSync(join(root, "bare", "src"), { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "shop", version: "2.3.4" }));
  writeFileSync(join(app, "node_modules", "tool", "package.json"), JSON.stringify({ version: "9.9.9" }));
  writeFileSync(join(root, "bare", "package.json"), JSON.stringify({ name: "no-version" }));
  const entry = join(app, "src", "server.js");
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function clean() {
    delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    delete process.env.npm_package_version; // `npm test` sets it to THIS package's version
  }

  it("the option wins over everything", () => {
    clean();
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=1.0.0";
    expect(resolveServiceVersion("5.0.0", entry, app)).toEqual({ version: "5.0.0", source: "option" });
  });

  it("then service.version from OTEL_RESOURCE_ATTRIBUTES", () => {
    clean();
    process.env.OTEL_RESOURCE_ATTRIBUTES = "team=core,service.version=1.0.0";
    expect(resolveServiceVersion(undefined, entry, app)).toEqual({ version: "1.0.0", source: "env" });
  });

  it("then npm_package_version (npm start / npm run hand it over)", () => {
    clean();
    process.env.npm_package_version = "3.0.0";
    expect(resolveServiceVersion(undefined, entry, app)).toEqual({ version: "3.0.0", source: "package.json" });
  });

  it("then the nearest package.json above the entry script", () => {
    clean();
    expect(resolveServiceVersion(undefined, entry, root)).toEqual({ version: "2.3.4", source: "package.json" });
  });

  it("never an installed library's: an entry inside node_modules falls back to the working dir", () => {
    clean();
    const cli = join(app, "node_modules", "tool", "cli.js");
    expect(appPackageVersion(cli, app)).toBe("2.3.4");
  });

  it("the nearest package.json is the answer even without a version - no climbing past it", () => {
    clean();
    expect(resolveServiceVersion(undefined, join(root, "bare", "src", "x.js"), root)).toEqual({
      version: "0.0.0",
      source: "default",
    });
  });

  it("an unreadable package.json is 'not set', never an error", () => {
    clean();
    const broken = join(root, "broken");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), "{ not json");
    expect(appPackageVersion(join(broken, "x.js"), broken)).toBeUndefined();
  });

  it("and resolveConfig carries it to the resource", () => {
    clean();
    process.env.OTEL_RESOURCE_ATTRIBUTES = "service.version=4.5.6";
    const cfg = resolveConfig({ apiKey: "k" });
    expect(cfg.serviceVersionSource).toBe("env");
    expect(buildResource(cfg).attributes["service.version"]).toBe("4.5.6");
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
