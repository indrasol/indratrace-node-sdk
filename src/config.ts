/**
 * Config resolution: the API key, and a small number of optional labels.
 *
 * The key decides identity: `product`, `deployment.environment` and `tenant.id` are
 * stamped by the ingest gateway from the key, so they are not ours to resolve or to
 * send (docs/conventions.md).
 */
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
  type Resource,
} from "@opentelemetry/resources";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { VERSION } from "./version.js";

/**
 * The only error that ever reaches the caller, and only from `initObservability`:
 * a startup mistake (no key) a developer is standing in front of. Runtime
 * failures are logged and dropped, never thrown.
 */
export class IndraTraceConfigError extends Error {
  override name = "IndraTraceConfigError";
}

/** Where telemetry goes when `INDRATRACE_ENDPOINT` is unset: the production gateway. */
export const DEFAULT_ENDPOINT = "https://ingest.indratrace.com";
export const DEFAULT_SERVICE_VERSION = "0.0.0";
/** One export attempt, OTel retries included. OTel's 10s default stalls process exit. */
export const EXPORT_TIMEOUT_MS = 3000;
/** Preflight: time to open the TCP connection, then time to get an answer. */
export const PREFLIGHT_CONNECT_TIMEOUT_MS = 2000;
export const PREFLIGHT_READ_TIMEOUT_MS = 3000;

export const ENV_API_KEY = "INDRATRACE_API_KEY";
/** Supported override for self-hosted and dev gateways. Env only, never an option. */
export const ENV_ENDPOINT = "INDRATRACE_ENDPOINT";
export const ENV_PREFLIGHT = "INDRATRACE_PREFLIGHT";
export const ENV_CAPTURE_CONTENT = "INDRATRACE_CAPTURE_CONTENT";
export const ENV_DEBUG = "INDRATRACE_DEBUG";

/** Fixed transport contract (docs/conventions.md, Transport). */
export const API_KEY_HEADER = "x-indratrace-key";

/** Owned by the gateway (`ingest/stamp.py::STAMPED_ATTRS`); the SDK never sends them. */
export const GATEWAY_STAMPED_ATTRS = ["product", "deployment.environment", "tenant.id"] as const;

export const MISSING_API_KEY_MESSAGE =
  "No API key. Set INDRATRACE_API_KEY or pass { apiKey: ... } - create one under " +
  "Products in your IndraTrace workspace; the key is shown once when the product is created.";

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

export type EndpointSource = "default" | "env";

/** Where the app's release number came from - shown in the debug banner. */
export type VersionSource = "option" | "env" | "package.json" | "default";

export interface ObsConfig {
  apiKey: string;
  endpoint: string;
  endpointSource: EndpointSource;
  /** undefined = let OpenTelemetry decide (OTEL_SERVICE_NAME, else unknown_service). */
  serviceName?: string;
  serviceVersion: string;
  serviceVersionSource: VersionSource;
}

export interface ConfigInput {
  apiKey?: string;
  serviceName?: string;
  serviceVersion?: string;
}

export function resolveConfig(input: ConfigInput = {}): ObsConfig {
  // Presence only, no format check: the gateway is the authority on what a valid key is.
  const apiKey = input.apiKey || process.env[ENV_API_KEY];
  if (!apiKey) throw new IndraTraceConfigError(MISSING_API_KEY_MESSAGE);
  const override = process.env[ENV_ENDPOINT];
  const version = resolveServiceVersion(input.serviceVersion);
  return {
    apiKey,
    endpoint: override || DEFAULT_ENDPOINT,
    endpointSource: override ? "env" : "default",
    serviceName: input.serviceName || undefined,
    serviceVersion: version.version,
    serviceVersionSource: version.source,
  };
}

/**
 * The app's release number, first answer wins - so the one-line `--import` start needs
 * no option for it:
 *   1. the `serviceVersion` option (set in code, on purpose);
 *   2. `service.version` in OTEL_RESOURCE_ATTRIBUTES (set in the server's settings, on purpose);
 *   3. the app's own package.json `version` (found by us - the fallback);
 *   4. else 0.0.0, which IndraTrace reads as "not set".
 */
export function resolveServiceVersion(
  explicit: string | undefined,
  entry: string | undefined = process.argv[1],
  cwd: string = process.cwd(),
): { version: string; source: VersionSource } {
  if (explicit) return { version: explicit, source: "option" };
  const fromEnv = detectResources({ detectors: [envDetector] }).attributes["service.version"];
  if (typeof fromEnv === "string" && fromEnv) return { version: fromEnv, source: "env" };
  const fromPackage = appPackageVersion(entry, cwd);
  if (fromPackage) return { version: fromPackage, source: "package.json" };
  return { version: DEFAULT_SERVICE_VERSION, source: "default" };
}

const IN_NODE_MODULES = /[\\/]node_modules([\\/]|$)/;

/**
 * The `version` of the app's own package.json. `npm start` / `npm run` already hand it
 * over as npm_package_version; otherwise the nearest package.json at or above the
 * entry script. Never an installed library's: an entry inside node_modules (a CLI that
 * runs the app) falls back to the working directory. The NEAREST package.json is the
 * answer even without a version - climbing past it would read some other project's.
 * Any read or parse failure is "no version", never an error.
 */
export function appPackageVersion(entry: string | undefined, cwd: string): string | undefined {
  const fromNpm = process.env.npm_package_version;
  if (fromNpm) return fromNpm;
  let dir = entry ? dirname(resolvePath(entry)) : cwd;
  if (IN_NODE_MODULES.test(dir)) dir = cwd;
  for (;;) {
    let text: string;
    try {
      text = readFileSync(join(dir, "package.json"), "utf8");
    } catch {
      const up = dirname(dir);
      if (up === dir) return undefined;
      dir = up;
      continue;
    }
    try {
      const version: unknown = JSON.parse(text).version;
      return typeof version === "string" && version.trim() ? version.trim() : undefined;
    } catch {
      return undefined;
    }
  }
}

export function signalUrl(cfg: ObsConfig, signal: "traces" | "logs" | "metrics"): string {
  return `${cfg.endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

export function headers(cfg: ObsConfig): Record<string, string> {
  return { [API_KEY_HEADER]: cfg.apiKey };
}

/** Explicit option > env var (truthy: 1/true/yes/on) > false. */
export function resolveFlag(explicit: boolean | undefined, envName: string): boolean {
  if (explicit !== undefined) return explicit;
  const raw = process.env[envName];
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

export type PreflightMode = "off" | "warn" | "strict";

export function resolvePreflightMode(): PreflightMode {
  const raw = (process.env[ENV_PREFLIGHT] ?? "").trim().toLowerCase();
  if (FALSY.has(raw)) return "off";
  if (raw === "strict") return "strict";
  return "warn";
}

/** `scheme://user:pass@` in a URL, anywhere in free text. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi;

export function redactUrlCredentials(text: string): string {
  return text.replace(URL_USERINFO, "$1***@");
}

/** Shorter than this and "redacting" would shred ordinary words (a key of "k" hits every k). */
const MIN_REDACT_LENGTH = 8;

export function redactApiKey(text: string, apiKey: string | undefined): string {
  if (!apiKey) return text;
  for (const form of new Set([apiKey, apiKey.trim(), JSON.stringify(apiKey).slice(1, -1)])) {
    if (form.length >= MIN_REDACT_LENGTH) text = text.split(form).join("[REDACTED]");
  }
  return text;
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\./.test(h);
}

/** A warning for plain http:// to a host that is not this machine, else undefined. */
export function plaintextEndpointWarning(endpoint: string): string | undefined {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || isLoopbackHost(url.hostname)) return undefined;
  return (
    `INDRATRACE_ENDPOINT is plain http:// (${url.hostname}): the API key and all ` +
    "telemetry will cross the network unencrypted. Use an https:// endpoint unless " +
    "this network is trusted."
  );
}

/**
 * The Resource stamped on every signal: OTel's defaults and OTEL_* env, then ours on
 * top. The gateway-stamped attributes are removed even if the environment injected
 * them (OTEL_RESOURCE_ATTRIBUTES), because the gateway would discard them anyway.
 */
export function buildResource(cfg: ObsConfig): Resource {
  const ours: Record<string, string> = {
    "service.version": cfg.serviceVersion,
    "telemetry.sdk.wrapper": `indratrace-js/${VERSION}`,
  };
  if (cfg.serviceName) ours["service.name"] = cfg.serviceName;
  const merged = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(resourceFromAttributes(ours));
  const attributes = { ...merged.attributes };
  for (const key of GATEWAY_STAMPED_ATTRS) delete attributes[key];
  return resourceFromAttributes(attributes);
}
