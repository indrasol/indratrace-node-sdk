/**
 * Startup preflight and export-failure surfacing: say *which* thing is wrong.
 *
 * A blocked firewall, a bad key and an
 * org with no card all look the same from outside (the app runs, nothing
 * arrives), so both the one-time startup probe and the export watcher map the
 * outcome to a named cause and one paragraph a human can act on.
 *
 * No message ever contains the key: they are built from the endpoint, the HTTP
 * status and the gateway's RFC 7807 `title`/`detail` only.
 */
import http from "node:http";
import https from "node:https";
import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";
import {
  API_KEY_HEADER,
  ENV_ENDPOINT,
  PREFLIGHT_CONNECT_TIMEOUT_MS,
  PREFLIGHT_READ_TIMEOUT_MS,
  redactApiKey,
  redactUrlCredentials,
  signalUrl,
  type ObsConfig,
} from "./config.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

/** Consecutive failed batches before the first ERROR: one is a blip, three is real. */
export const FAILURE_THRESHOLD = 3;
/** After the first report, at most one line per this many ms (5 minutes). */
export const REPORT_INTERVAL_MS = 300_000;

export const NO_CARD_TITLE = "no card on file";
export const SUSPENDED_TITLE = "account suspended";

export type Cause =
  | "ok"
  | "dns"
  | "egress-blocked"
  | "refused-localhost"
  | "refused"
  | "stalled"
  | "tls"
  | "unauthorized"
  | "no-card"
  | "suspended"
  | "not-gateway"
  | "rate-limited"
  | "collector-down"
  | "control-plane-down"
  | "unexpected";

/** Causes that are the caller's to fix (ERROR); the rest are ours or transient (WARNING). */
const MISCONFIGURATION = new Set<Cause>([
  "dns",
  "egress-blocked",
  "refused-localhost",
  "refused",
  "tls",
  "unauthorized",
  "no-card",
  "suspended",
  "not-gateway",
]);

export interface Diagnosis {
  cause: Cause;
  message: string;
  status?: number;
}

export function diagnosisLevel(d: Diagnosis): "error" | "warn" {
  return MISCONFIGURATION.has(d.cause) ? "error" : "warn";
}

function make(cause: Cause, message: string, status?: number): Diagnosis {
  return { cause, message: redactUrlCredentials(message), status };
}

// ── Messages. One function per cause, so each paragraph is reviewable on its own. ──

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function host(cfg: ObsConfig): string {
  try {
    return new URL(cfg.endpoint).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return cfg.endpoint;
  }
}

function port(cfg: ObsConfig): number {
  try {
    const url = new URL(cfg.endpoint);
    return url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  } catch {
    return 443;
  }
}

function where(cfg: ObsConfig): string {
  return cfg.endpointSource === "env" ? `as set by ${ENV_ENDPOINT}` : "the package default";
}

function curl(cfg: ObsConfig): string {
  return `curl -sS -o /dev/null -w '%{http_code}\\n' ${cfg.endpoint.replace(/\/+$/, "")}/health`;
}

const DROPPED = "Telemetry is being dropped until this is fixed.";
const quoted = (detail: string) => (detail ? `: ${detail}` : "");

const msg = {
  dns: (cfg: ObsConfig) =>
    `IndraTrace: the ingest hostname '${host(cfg)}' does not resolve (endpoint ${cfg.endpoint}, ` +
    `${where(cfg)}). Check the hostname for a typo; if it is right, this host's DNS cannot see ` +
    `it - a private DNS zone or a resolver that only answers for internal names. ${DROPPED}`,
  egress: (cfg: ObsConfig) =>
    `IndraTrace: could not open a connection to ${host(cfg)}:${port(cfg)} within ` +
    `${PREFLIGHT_CONNECT_TIMEOUT_MS / 1000}s - outbound egress from this host is blocked. A ` +
    `firewall, NSG, UDR or proxy in front of this service must allow outbound HTTPS on port ` +
    `${port(cfg)} to ${host(cfg)}. VNet-integrated Container Apps, App Service and VMs behind a ` +
    `firewall or a route table do not have this by default; plain ones do. Node's http client ` +
    `does not use HTTPS_PROXY on its own, so a host that can only egress through a proxy needs ` +
    `a direct route to ${host(cfg)}. Confirm from this machine with: ${curl(cfg)} - anything ` +
    `other than an HTTP status (a hang, 'no route to host') is an egress problem, not an ` +
    `IndraTrace problem. ${DROPPED}`,
  refusedLocalhost: (cfg: ObsConfig) =>
    `IndraTrace: nothing is listening at ${cfg.endpoint}. ${ENV_ENDPOINT} points this process at ` +
    `localhost, and no ingest gateway is running there. If you meant to send to IndraTrace, ` +
    `unset ${ENV_ENDPOINT} so the SDK uses the IndraTrace ingest endpoint; if you run a ` +
    `self-hosted or local gateway, start it first. ${DROPPED}`,
  refused: (cfg: ObsConfig) =>
    `IndraTrace: ${host(cfg)} refused the connection on port ${port(cfg)} (${cfg.endpoint}, ` +
    `${where(cfg)}). The host is reachable but nothing is listening on that port - check the ` +
    `port and scheme in the endpoint URL. ${DROPPED}`,
  stalled: (cfg: ObsConfig) =>
    `IndraTrace: connected to ${host(cfg)} but received no response within ` +
    `${PREFLIGHT_READ_TIMEOUT_MS / 1000}s (${cfg.endpoint}, ${where(cfg)}). A proxy or firewall ` +
    `is accepting the connection and dropping the request; check for an egress proxy that only ` +
    `allows an allow-list, or a TLS-inspecting appliance. ${DROPPED}`,
  tls: (cfg: ObsConfig) =>
    `IndraTrace: TLS verification failed for ${host(cfg)} (${cfg.endpoint}). The certificate ` +
    `this host was shown is not trusted by this Node.js - almost always an intercepting ` +
    `corporate proxy re-signing outbound traffic. Either point NODE_EXTRA_CA_CERTS at your ` +
    `organisation's CA bundle, or exempt ${host(cfg)} from interception. Do not disable ` +
    `verification. ${DROPPED}`,
  unauthorized: (cfg: ObsConfig, detail: string) =>
    `IndraTrace: the ingest gateway at ${host(cfg)} rejected the API key (HTTP 401` +
    `${quoted(detail)}). This is the key, not the network - the gateway was reached. Check ` +
    `INDRATRACE_API_KEY in the *running* process for stray whitespace or a trailing newline ` +
    `from copy-paste, that it is the full value shown once when the key was minted, and that ` +
    `the key has not been revoked or expired. ${DROPPED}`,
  noCard: (_cfg: ObsConfig, detail: string) =>
    `IndraTrace: the key is valid, but its organisation is not an internal one and has no card ` +
    `on file, so its telemetry is refused (HTTP 402${quoted(detail)}). The usual cause is a ` +
    `workspace created with a personal, non-work email address, which is not recognised as ` +
    `internal. Save a card at Settings > Usage & billing, or have the workspace re-created ` +
    `with a work email. ${DROPPED}`,
  suspended: (_cfg: ObsConfig, detail: string) =>
    `IndraTrace: the key is valid, but its organisation is suspended for an unpaid invoice ` +
    `(HTTP 402${quoted(detail)}). Pay at Settings > Usage & billing to resume sending. ${DROPPED}`,
  notGateway: (cfg: ObsConfig, status: number) =>
    `IndraTrace: ${cfg.endpoint} (${where(cfg)}) answered HTTP ${status} - something is ` +
    `listening there, but it is not the IndraTrace ingest gateway. The endpoint must be the ` +
    `gateway's base URL with no path; the SDK appends /v1/traces itself. ${DROPPED}`,
  rateLimited: (_cfg: ObsConfig, detail: string) =>
    `IndraTrace: the gateway is rate-limiting this key or organisation (HTTP 429` +
    `${quoted(detail)}). Configuration is fine; the SDK backs off and retries. If this ` +
    `persists, this service is sending faster than the organisation's ingest quota.`,
  collectorDown: (cfg: ObsConfig, detail: string) =>
    `IndraTrace: the gateway at ${host(cfg)} accepted the key but cannot reach the collector ` +
    `behind it (HTTP 502${quoted(detail)}). Nothing to fix on your side; the SDK retries, and ` +
    `telemetry it cannot deliver is dropped, not queued.`,
  controlPlaneDown: (cfg: ObsConfig, detail: string) =>
    `IndraTrace: the gateway at ${host(cfg)} could not validate the key because its control ` +
    `plane is unavailable (HTTP 503${quoted(detail)}). Nothing to fix on your side; the SDK ` +
    `retries.`,
  unexpected: (cfg: ObsConfig, status: number, title: string, detail: string) =>
    `IndraTrace: the ingest gateway at ${host(cfg)} answered HTTP ${status} (` +
    `${title || "no problem body"}${quoted(detail)}) to the startup preflight. This is not one ` +
    `of the outcomes the SDK knows how to explain; check the gateway's logs or contact support ` +
    `with this line.`,
};

// ── Classification. ──

/** The error and everything it wraps: `cause`, and AggregateError's `errors`. */
function chain(err: unknown): unknown[] {
  const seen: unknown[] = [];
  const stack = [err];
  while (stack.length) {
    const cur = stack.pop();
    if (cur == null || seen.includes(cur)) continue;
    seen.push(cur);
    if (typeof cur === "object") {
      const o = cur as { cause?: unknown; errors?: unknown };
      if (o.cause) stack.push(o.cause);
      if (Array.isArray(o.errors)) stack.push(...o.errors);
    }
  }
  return seen;
}

const TLS_CODE = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/;

export function diagnoseException(err: unknown, cfg: ObsConfig): Diagnosis {
  const all = chain(err);
  const codes = new Set(
    all.map((e) => (e as { code?: unknown })?.code).filter((c): c is string => typeof c === "string"),
  );
  const text = all
    .map((e) => (e instanceof Error ? e.message : String(e)))
    .join(" | ")
    .toLowerCase();
  const has = (...cs: string[]) => cs.some((c) => codes.has(c));

  let d: Diagnosis;
  if (has("ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME") || text.includes("getaddrinfo")) {
    d = make("dns", msg.dns(cfg));
  } else if ([...codes].some((c) => TLS_CODE.test(c)) || text.includes("certificate")) {
    d = make("tls", msg.tls(cfg));
  } else if (has("ECONNREFUSED") || text.includes("econnrefused")) {
    d = LOOPBACK_HOSTS.has(host(cfg))
      ? make("refused-localhost", msg.refusedLocalhost(cfg))
      : make("refused", msg.refused(cfg));
  } else if (has("IT_READ_TIMEOUT")) {
    d = make("stalled", msg.stalled(cfg));
  } else if (
    // A connect that never completes, a route that does not exist, a reset, or an
    // exporter timeout with no answer at all: the firewall/NSG/UDR signature.
    has("IT_CONNECT_TIMEOUT", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "EPIPE") ||
    /timeout|timed out|socket hang up|network|connect/.test(text)
  ) {
    d = make("egress-blocked", msg.egress(cfg));
  } else {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    d = make("unexpected", `IndraTrace: the startup preflight to ${cfg.endpoint} failed with ${name}: ${message}. ${DROPPED}`);
  }
  return { ...d, message: redactApiKey(d.message, cfg.apiKey) };
}

/** `(title, detail)` from an RFC 7807 body, truncated (it ends up in a log line). */
export function problemFields(body: string | undefined): [string, string] {
  if (!body) return ["", ""];
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object") return ["", ""];
    const { title, detail } = parsed as { title?: unknown; detail?: unknown };
    return [
      typeof title === "string" ? title.slice(0, 200) : "",
      typeof detail === "string" ? detail.slice(0, 400) : "",
    ];
  } catch {
    return ["", ""];
  }
}

export function diagnoseStatus(status: number, body: string | undefined, cfg: ObsConfig): Diagnosis {
  if (status >= 200 && status < 300) return { cause: "ok", message: "", status };
  const [title, detail] = problemFields(body);
  switch (status) {
    case 401:
      return make("unauthorized", msg.unauthorized(cfg, detail), status);
    case 402:
      // The gateway has exactly two 402s; the title is the only thing that tells them apart.
      return title === SUSPENDED_TITLE
        ? make("suspended", msg.suspended(cfg, detail), status)
        : make("no-card", msg.noCard(cfg, detail), status);
    case 404:
    case 405:
      return make("not-gateway", msg.notGateway(cfg, status), status);
    case 429:
      return make("rate-limited", msg.rateLimited(cfg, detail), status);
    case 502:
      return make("collector-down", msg.collectorDown(cfg, detail), status);
    case 503:
      return make("control-plane-down", msg.controlPlaneDown(cfg, detail), status);
    default:
      return make("unexpected", msg.unexpected(cfg, status, title, detail), status);
  }
}

// ── The startup preflight. ──

function timeoutError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * One authenticated, empty OTLP/protobuf POST to /v1/traces (zero bytes is a
 * valid empty request), so the gateway's real 401/402 are what we read - a GET
 * /health would prove reachability only. Uses node:http(s) like the exporters,
 * so it takes the same route they will. Never rejects.
 */
export function runPreflight(cfg: ObsConfig): Promise<Diagnosis> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(signalUrl(cfg, "traces"));
    } catch (err) {
      resolve(diagnoseException(err, cfg));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (d: Diagnosis) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(d);
    };
    const fail = (code: string) => finish(diagnoseException(timeoutError(code), cfg));
    let connected = false;
    // A timer can fire late and ahead of I/O that is already waiting: an app that
    // loads its modules synchronously for 2+ s at boot blocks the event loop, and
    // Node runs due timers before pending I/O. setImmediate runs after that I/O, so
    // a connection or response that did arrive is seen before we call it a timeout.
    const expire = (code: "IT_CONNECT_TIMEOUT" | "IT_READ_TIMEOUT") =>
      setImmediate(() => {
        if (code === "IT_CONNECT_TIMEOUT" && connected) return;
        fail(code);
      });
    // Our own request must not become a span in the customer's trace data.
    const req = context.with(suppressTracing(context.active()), () =>
      (url.protocol === "https:" ? https : http).request(url, {
        method: "POST",
        agent: false,
        headers: {
          [API_KEY_HEADER]: cfg.apiKey,
          "content-type": "application/x-protobuf",
          "content-length": "0",
          "user-agent": `indratrace-js-preflight/${VERSION}`,
        },
      }),
    );
    timer = setTimeout(() => expire("IT_CONNECT_TIMEOUT"), PREFLIGHT_CONNECT_TIMEOUT_MS);
    req.on("socket", (socket) => {
      socket.once("connect", () => {
        connected = true;
        clearTimeout(timer);
        timer = setTimeout(() => expire("IT_READ_TIMEOUT"), PREFLIGHT_READ_TIMEOUT_MS);
      });
    });
    req.on("response", (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        if (body.length < 65_536) body += chunk;
      });
      res.on("end", () => finish(diagnoseStatus(res.statusCode ?? 0, body, cfg)));
      res.on("error", (err) => finish(diagnoseException(err, cfg)));
    });
    req.on("error", (err) => finish(diagnoseException(err, cfg)));
    req.end();
  });
}

// ── Export-failure surfacing. ──

/**
 * Counts consecutive export failures across traces, logs and metrics (one host,
 * one key, so one diagnosis), logs it once past the threshold, then at most once
 * per interval, then one recovery line.
 */
export class ExportHealth {
  private consecutive = 0;
  private sinceReport = 0;
  private lastReportAt: number | undefined;
  private reported = false;

  constructor(
    private readonly cfg: ObsConfig,
    private readonly threshold = FAILURE_THRESHOLD,
    private readonly intervalMs = REPORT_INTERVAL_MS,
    private readonly clock: () => number = Date.now,
  ) {}

  recordFailure(signal: string, error: unknown): void {
    this.consecutive += 1;
    this.sinceReport += 1;
    if (this.consecutive < this.threshold) return;
    const now = this.clock();
    if (this.reported && this.lastReportAt !== undefined && now - this.lastReportAt < this.intervalMs) return;
    const d = this.diagnose(error);
    const dropped = this.sinceReport;
    const first = !this.reported;
    this.sinceReport = 0;
    this.lastReportAt = now;
    this.reported = true;
    const text = d.message || `HTTP ${d.status}`;
    log[diagnosisLevel(d)](
      first
        ? `${dropped} consecutive export batches failed (last: ${signal}). ${text} Further ` +
            `failures are reported at most every ${Math.max(1, Math.floor(this.intervalMs / 60_000))} minutes.`
        : `exports still failing - ${dropped} more batches dropped (last: ${signal}). ${text}`,
    );
  }

  recordSuccess(signal: string): void {
    const failed = this.consecutive;
    const reported = this.reported;
    this.consecutive = 0;
    this.sinceReport = 0;
    this.reported = false;
    this.lastReportAt = undefined;
    if (reported) log.info(`exports recovered (${signal}) after ${failed} failed batches`);
  }

  /** An OTLPExporterError carries the HTTP status in a numeric `code` and the body in `data`. */
  diagnose(error: unknown): Diagnosis {
    const e = error as { code?: unknown; data?: unknown } | undefined;
    if (e && typeof e.code === "number") {
      return diagnoseStatus(e.code, typeof e.data === "string" ? e.data : undefined, this.cfg);
    }
    if (error === undefined) return make("egress-blocked", msg.egress(this.cfg));
    return diagnoseException(error, this.cfg);
  }
}
