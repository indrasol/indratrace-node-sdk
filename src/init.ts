/**
 * initObservability: wire OpenTelemetry to ship to IndraTrace. Port of the Python
 * SDK's `init.py`.
 *
 * Fail silent (Python ADR 0003): the only error that reaches the caller is
 * IndraTraceConfigError for a missing key (and, with INDRATRACE_PREFLIGHT=strict,
 * a rejected returned promise). Everything else is logged and dropped.
 */
import { createRequire, register } from "node:module";
import * as workerThreads from "node:worker_threads";
import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations, type Instrumentation } from "@opentelemetry/instrumentation";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { WinstonInstrumentation } from "@opentelemetry/instrumentation-winston";
import { BatchLogRecordProcessor, LoggerProvider, type LogRecordExporter } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { BatchSpanProcessor, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { AnthropicInstrumentation } from "@traceloop/instrumentation-anthropic";
import { OpenAIInstrumentation } from "@traceloop/instrumentation-openai";
import { FastifyOtelInstrumentation } from "@fastify/otel";
import {
  buildResource,
  ENV_CAPTURE_CONTENT,
  ENV_DEBUG,
  EXPORT_TIMEOUT_MS,
  headers,
  IndraTraceConfigError,
  plaintextEndpointWarning,
  redactUrlCredentials,
  resolveConfig,
  resolveFlag,
  resolvePreflightMode,
  signalUrl,
  type ObsConfig,
} from "./config.js";
import { SessionSpanProcessor } from "./context.js";
import { errorText, log } from "./log.js";
import { diagnosisLevel, ExportHealth, runPreflight } from "./preflight.js";
import { INSTRUMENTATION_SCOPE, state } from "./state.js";
import { VERSION } from "./version.js";

export interface InitOptions {
  /** The IndraTrace API key. Falls back to INDRATRACE_API_KEY. The only required config. */
  apiKey?: string;
  /** Name of this deployable (an API vs a worker). Defaults to OTEL_SERVICE_NAME, else unknown_service. */
  serviceName?: string;
  /** Your app's version, e.g. "1.4.2". Defaults to 0.0.0. */
  serviceVersion?: string;
  /** Record prompt/completion TEXT on model spans. Off by default. Env: INDRATRACE_CAPTURE_CONTENT. */
  captureContent?: boolean;
  /** Print a startup banner and every export result. Env: INDRATRACE_DEBUG. */
  debug?: boolean;
}

interface Exportable<T> {
  export(items: T, resultCallback: (result: ExportResult) => void): void;
}

/** Test seam, not public API: replace the OTLP trace/log exporters. */
const testExporters: { traces?: SpanExporter; logs?: LogRecordExporter } = {};
export function _useExportersForTests(e: { traces?: SpanExporter; logs?: LogRecordExporter }): void {
  Object.assign(testExporters, e);
}

/**
 * Wrap an exporter's export() so every attempt reports to the health tracker, and
 * with debug on narrates "export ok" / "export FAILED". Observes only: the result
 * reaches OTel unchanged.
 */
function observeExport<T, E extends Exportable<T>>(exporter: E, signal: string, health: ExportHealth, audible: boolean): E {
  const real = exporter.export.bind(exporter);
  exporter.export = (items: T, done: (result: ExportResult) => void) =>
    real(items, (result) => {
      try {
        if (result.code === ExportResultCode.SUCCESS) {
          if (audible) log.debug(`${signal} export ok`);
          health.recordSuccess(signal);
        } else {
          if (audible) log.warn(`${signal} export FAILED: ${result.error ? errorText(result.error) : "no response"}`);
          health.recordFailure(signal, result.error);
        }
      } catch {
        // observing must never change the export
      }
      done(result);
    });
  return exporter;
}

type InstrumentationSpec = [label: string, make: () => Instrumentation];

function instrumentationSpecs(captureContent: boolean): InstrumentationSpec[] {
  return [
    ["http", () => new HttpInstrumentation()],
    ["fetch", () => new UndiciInstrumentation()],
    ["express", () => new ExpressInstrumentation()],
    ["fastify", () => new FastifyOtelInstrumentation({ registerOnInitialization: true })],
    // traceContent is passed both ways on purpose: the instrumentors treat "unset" as ON.
    ["openai", () => new OpenAIInstrumentation({ traceContent: captureContent })],
    ["anthropic", () => new AnthropicInstrumentation({ traceContent: captureContent })],
    ["pino", () => new PinoInstrumentation()],
    ["winston", () => new WinstonInstrumentation()],
  ];
}

type Patchable = { manuallyInstrument(m: any): void; unpatch(m: any): void };

async function tryImport(specifier: string): Promise<any> {
  try {
    return await import(specifier);
  } catch {
    return undefined; // not installed: nothing to patch
  }
}

function tryRequire(specifier: string): any {
  try {
    return createRequire(import.meta.url)(specifier);
  } catch {
    return undefined; // not installed, or ESM-only
  }
}

/**
 * Patch openai and @anthropic-ai/sdk directly, on both of their builds, wherever
 * the require hook has not already done it:
 *  - ESM build: the tracers bundle an older @opentelemetry/instrumentation whose
 *    import hook cannot run beside the current one, so `import OpenAI from
 *    "openai"` is never hooked (Traceloop documents direct patching for ESM).
 *  - CJS build: the hook skips versions outside the tracer's declared range
 *    (openai 7 today, where the calls are otherwise unchanged).
 * Loading the CJS build here fires the require hook first, so an in-range version
 * is hook-patched and skipped below: never wrapped twice. Prototype patches apply
 * even to clients created before init. The CJS pass runs synchronously, inside
 * initObservability(), so a CJS app's first call is traced; the ESM pass needs an
 * async import() and is what the returned promise waits for. Undo functions go
 * into `undo`. Never rejects.
 */
function patchAiSdks(instrumentations: Instrumentation[], statuses: [string, string][], undo: (() => void)[]): Promise<void> {
  const find = (cls: Function) => instrumentations.find((i) => i instanceof cls) as Patchable | undefined;
  const targets = [
    {
      label: "openai",
      inst: find(OpenAIInstrumentation),
      specifier: "openai",
      // manuallyInstrument takes the OpenAI class; unpatch takes { OpenAI }.
      cls: (m: any) => m?.OpenAI ?? m?.default,
      method: (cls: any) => cls?.Chat?.Completions?.prototype?.create,
      patch: (inst: Patchable, cls: any) => inst.manuallyInstrument(cls),
      unpatch: (inst: Patchable, cls: any) => inst.unpatch({ OpenAI: cls }),
    },
    {
      label: "anthropic",
      inst: find(AnthropicInstrumentation),
      specifier: "@anthropic-ai/sdk",
      // Both take the module shape { Anthropic }.
      cls: (m: any) => m?.Anthropic ?? m?.default,
      method: (cls: any) => cls?.Messages?.prototype?.create,
      patch: (inst: Patchable, cls: any) => inst.manuallyInstrument({ Anthropic: cls }),
      unpatch: (inst: Patchable, cls: any) => inst.unpatch({ Anthropic: cls }),
    },
  ].filter((t) => t.inst !== undefined);

  const patchBuild = (t: (typeof targets)[number], build: "cjs" | "esm", mod: unknown) => {
    const cls = t.cls(mod);
    const create = t.method(cls);
    if (typeof create !== "function") return;
    if ((create as { __wrapped?: boolean }).__wrapped) {
      statuses.push([`${t.label}:${build}`, "enabled"]);
      return;
    }
    try {
      const inst = t.inst!;
      t.patch(inst, cls);
      undo.push(() => t.unpatch(inst, cls));
      statuses.push([`${t.label}:${build}`, "enabled (patched directly)"]);
    } catch (err) {
      log.debug(`patching the ${build} build of ${t.specifier} failed: ${errorText(err)}`);
      statuses.push([`${t.label}:${build}`, `skipped (${errorText(err)})`]);
    }
  };

  for (const t of targets) patchBuild(t, "cjs", tryRequire(t.specifier));
  return (async () => {
    for (const t of targets) patchBuild(t, "esm", await tryImport(t.specifier));
  })().catch(() => {});
}

/** Libraries that must load AFTER init to be patched. */
const PATCHED_LIBRARIES = ["express", "fastify", "openai", "@anthropic-ai/sdk", "pino", "winston"];

/**
 * The Node twin of Python's "Flask imported before init" warning: a library already
 * in the require cache was loaded before its instrumentation existed, so it
 * silently produces zero spans. Heuristic (native-ESM loads are not in this cache).
 */
function librariesLoadedTooEarly(): string[] {
  try {
    const cache = createRequire(import.meta.url).cache;
    const paths = Object.keys(cache).map((p) => p.replace(/\\/g, "/"));
    return PATCHED_LIBRARIES.filter((lib) => paths.some((p) => p.includes(`/node_modules/${lib}/`)));
  } catch {
    return [];
  }
}

function banner(cfg: ObsConfig, serviceName: string, captureContent: boolean, statuses: [string, string][]): string {
  return [
    `IndraTrace SDK v${VERSION} (node) initialized`,
    `  service=${serviceName} version=${cfg.serviceVersion}`,
    `  endpoint=${redactUrlCredentials(cfg.endpoint)} (traces=${redactUrlCredentials(signalUrl(cfg, "traces"))})`,
    `  api_key=set capture_content=${captureContent ? "on" : "off"}`,
    "  identity: product, deployment.environment and tenant.id are stamped by IndraTrace from your API key",
    "  signals: traces + logs + metrics (OTLP/HTTP, batched)",
    ...statuses.map(([label, status]) => `  instrumentation[${label}]: ${status}`),
  ].join("\n");
}

async function preflight(cfg: ObsConfig): Promise<void> {
  const mode = resolvePreflightMode();
  if (mode === "off") {
    log.debug("startup preflight disabled (INDRATRACE_PREFLIGHT)");
    return;
  }
  const d = await runPreflight(cfg);
  if (d.cause === "ok") {
    log.debug(`startup preflight ok (endpoint=${redactUrlCredentials(cfg.endpoint)})`);
    return;
  }
  if (mode === "strict") throw new IndraTraceConfigError(d.message);
  log[diagnosisLevel(d)](d.message);
}

/**
 * Wire OpenTelemetry to ship telemetry to IndraTrace. Call once, at startup,
 * BEFORE importing express/fastify/openai/@anthropic-ai/sdk/pino/winston - or use
 * `node --import indratrace/register app.js`.
 *
 * Throws IndraTraceConfigError synchronously when there is no API key. Returns a
 * promise that settles when startup is done (AI SDKs patched, one-time preflight
 * finished); you do not need to await it. It never rejects unless INDRATRACE_PREFLIGHT=strict.
 * Calling it twice is a no-op.
 */
export function initObservability(options: InitOptions = {}): Promise<void> {
  // Node also runs --require preload files inside its internal module-loader
  // thread (Node >= 22.14 flags it). Telemetry there would be a second SDK, and a
  // second loader-hook registration that only prints a warning.
  if ((workerThreads as { isInternalThread?: boolean }).isInternalThread) return Promise.resolve();
  const s = state();
  if (s.initialized) {
    log.debug("initObservability() already called; ignoring");
    return s.ready;
  }
  const cfg = resolveConfig(options);
  const debug = resolveFlag(options.debug, ENV_DEBUG);
  const captureContent = resolveFlag(options.captureContent, ENV_CAPTURE_CONTENT);
  log.configure({ debug, apiKey: cfg.apiKey });
  s.initialized = true;

  try {
    if (!s.importHookRegistered) {
      // ESM `import` of a CommonJS package (express, pino, ...) bypasses the require
      // hook, so ESM apps need this loader hook, registered before those imports run.
      // Once per process: a second registration only produces a warning.
      s.importHookRegistered = true;
      register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
    }
    if (debug) {
      // OTel's own warnings (exporter errors and the like), through our redacting logger.
      diag.setLogger(
        { error: (m) => log.warn(`otel: ${m}`), warn: (m) => log.warn(`otel: ${m}`), info() {}, debug() {}, verbose() {} },
        DiagLogLevel.WARN,
      );
    }
    const plaintext = plaintextEndpointWarning(cfg.endpoint);
    if (plaintext) log.warn(plaintext);

    const health = new ExportHealth(cfg);
    const resource = buildResource(cfg);
    const common = { headers: headers(cfg), timeoutMillis: EXPORT_TIMEOUT_MS };

    const spanExporter = observeExport(
      testExporters.traces ?? new OTLPTraceExporter({ url: signalUrl(cfg, "traces"), ...common }),
      "traces",
      health,
      debug,
    );
    const tracerProvider = new NodeTracerProvider({
      resource,
      // Session processor first, so session.id/user.id are on the span before it is batched.
      spanProcessors: [new SessionSpanProcessor(), new BatchSpanProcessor(spanExporter)],
    });
    // Trace context only, NOT baggage: the http/fetch instrumentations would otherwise
    // forward session.id/user.id in a `baggage` header to every outbound call,
    // including third-party APIs.
    tracerProvider.register({ propagator: new W3CTraceContextPropagator() });
    s.tracerProvider = tracerProvider;

    const logExporter = observeExport(
      testExporters.logs ?? new OTLPLogExporter({ url: signalUrl(cfg, "logs"), ...common }),
      "logs",
      health,
      debug,
    );
    const loggerProvider = new LoggerProvider({ resource, processors: [new BatchLogRecordProcessor({ exporter: logExporter })] });
    logs.setGlobalLoggerProvider(loggerProvider);
    s.loggerProvider = loggerProvider;

    const metricExporter = observeExport(
      new OTLPMetricExporter({ url: signalUrl(cfg, "metrics"), ...common }),
      "metrics",
      health,
      debug,
    );
    const meterProvider = new MeterProvider({
      resource,
      readers: [new PeriodicExportingMetricReader({ exporter: metricExporter, exportTimeoutMillis: EXPORT_TIMEOUT_MS })],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    s.meterProvider = meterProvider;

    const tooEarly = librariesLoadedTooEarly();
    const statuses: [string, string][] = [];
    for (const [label, make] of instrumentationSpecs(captureContent)) {
      try {
        const instrumentation = make();
        registerInstrumentations({ instrumentations: [instrumentation], tracerProvider, meterProvider, loggerProvider });
        s.instrumentations.push(instrumentation);
        statuses.push([label, "enabled"]);
      } catch (err) {
        log.debug(`enabling ${label} instrumentation failed: ${errorText(err)}`);
        statuses.push([label, `skipped (${errorText(err)})`]);
      }
    }
    if (tooEarly.length) {
      log.warn(
        `${tooEarly.join(", ")} loaded before initObservability(), so ${tooEarly.length > 1 ? "they" : "it"} ` +
          "will produce no spans or logs. Start the app with `node --import indratrace/register app.js`, " +
          "or call initObservability() in a file that is imported before anything else.",
      );
    }

    const aiPatched = patchAiSdks(s.instrumentations, statuses, s.cleanups).then(() => {
      if (debug) {
        const serviceName = String(resource.attributes["service.name"] ?? "unknown_service");
        log.debug(banner(cfg, serviceName, captureContent, statuses));
      }
    }).catch(() => {});
    s.aiPatched = aiPatched;

    if (debug) {
      // One startup span, flushed now, so debug reports reachability immediately.
      tracerProvider.getTracer(INSTRUMENTATION_SCOPE).startSpan("indratrace.startup").end();
      tracerProvider.forceFlush().catch(() => {});
    }

    // Short scripts: flush what is buffered when the event loop empties. We do not
    // install signal handlers (that would change how the app exits); servers call
    // shutdown() from their own SIGTERM handling.
    if (!s.exitHookInstalled) {
      s.exitHookInstalled = true;
      process.on("beforeExit", () => {
        if (state().initialized) void shutdown();
      });
    }
  } catch (err) {
    log.warn(`initObservability failed; the app keeps running without telemetry: ${errorText(err)}`);
    void shutdown();
    return Promise.resolve();
  }

  const checked = preflight(cfg).catch((err: unknown) => {
    if (err instanceof IndraTraceConfigError) throw err;
    log.debug(`startup preflight crashed: ${errorText(err)}`);
  });
  s.ready = Promise.all([s.aiPatched, checked]).then(() => {});
  return s.ready;
}

/**
 * Flush everything buffered and stop. Call it from your SIGTERM handler. After it
 * resolves, initObservability() may be called again. Never rejects.
 */
export async function shutdown(): Promise<void> {
  const s = state();
  const { tracerProvider, loggerProvider, meterProvider, instrumentations } = s;
  await s.aiPatched;
  const cleanups = s.cleanups.splice(0);
  s.initialized = false;
  s.tracerProvider = s.loggerProvider = s.meterProvider = undefined;
  s.instrumentations = [];
  s.ready = Promise.resolve();
  s.aiPatched = Promise.resolve();
  for (const undo of cleanups) {
    try {
      undo();
    } catch {
      // best-effort
    }
  }
  for (const i of instrumentations) {
    try {
      i.disable();
    } catch {
      // best-effort
    }
  }
  await Promise.allSettled([tracerProvider?.shutdown(), loggerProvider?.shutdown(), meterProvider?.shutdown()]);
  trace.disable();
  context.disable();
  propagation.disable();
  logs.disable();
  metrics.disable();
  diag.disable();
}
