# Conventions: what this package sends

This is the contract between the `indratrace` package and the IndraTrace platform:
every attribute name and transport rule the platform relies on. A change to anything
here is a change to what the platform reads, so it is made deliberately, recorded in
`CHANGELOG.md`, and covered by a test.

## Transport

- OTLP over HTTP (protobuf) to the IndraTrace ingest gateway:
  `<endpoint>/v1/traces`, `<endpoint>/v1/logs`, `<endpoint>/v1/metrics`.
- `<endpoint>` is `https://ingest.indratrace.com`, or `INDRATRACE_ENDPOINT` when set
  (self-hosted gateways and IndraTrace's own development only). There is no endpoint
  option in code.
- Auth header on every request: `x-indratrace-key: <api key>`. The key comes from the
  `apiKey` option or `INDRATRACE_API_KEY` and is required.
- Batched export in the background, 3 s timeout per attempt. On failure: retry per
  OpenTelemetry defaults, then drop. Never block the app.
- Trace context goes to downstream services in the W3C `traceparent` header. Baggage
  is **not** propagated, so session and user ids never leave in headers.

## Resource attributes (on every signal)

Sent by the package:

| Attribute | Value |
|---|---|
| `service.name` | the `serviceName` option, else `OTEL_SERVICE_NAME`, else OpenTelemetry's `unknown_service:...` |
| `service.version` | the `serviceVersion` option, else `service.version` from `OTEL_RESOURCE_ATTRIBUTES`, else the app's own `package.json` `version` (`npm_package_version`, else the nearest `package.json` at or above the entry script - never one inside `node_modules`), else `0.0.0`, which the platform reads as "not set" |
| `telemetry.sdk.wrapper` | `indratrace-js/<package version>` |

Stamped by the gateway from the API key, **never sent** by the package (removed even
if `OTEL_RESOURCE_ATTRIBUTES` sets them):

| Attribute | Decided by |
|---|---|
| `tenant.id` | the workspace the key belongs to |
| `product` | the product the key was created for |
| `deployment.environment` | that product's registered environment |

## Spans

| Source | Span name | Attributes |
|---|---|---|
| `traceAgent(name, fn)` | `agent <name>` | `indratrace.span.kind = "agent"`, `agent.name` |
| `traceTool(fn)` / `traceTool(name, fn)` | `tool <name>` | `indratrace.span.kind = "tool"`, `tool.name` |
| `traceStep(fn)` / `traceStep(name, fn)` | `step <name>` | `indratrace.span.kind = "step"`, `step.name` |
| `recordFeedback(score, opts)` | `feedback` | `indratrace.span.kind = "feedback"`, `feedback.score`, optional `feedback.comment`, `feedback.trace_id` (32-char lowercase hex) |
| HTTP, Express, Fastify, `fetch` | as the OpenTelemetry instrumentation names them | as the instrumentation emits them (`http.route`, `http.request.method`, ...), unchanged |

A failed agent/tool/step span has status ERROR and an `exception` event; the original
error is re-thrown unchanged.

### Model calls (OpenAI, Anthropic, and `recordLlmUsage`)

| Attribute | Meaning |
|---|---|
| `gen_ai.provider.name` | `openai`, `anthropic`, or the `system` passed to `recordLlmUsage` (default `other`) |
| `gen_ai.request.model` / `gen_ai.response.model` | model asked for / model that answered |
| `gen_ai.usage.input_tokens` / `gen_ai.usage.output_tokens` / `gen_ai.usage.total_tokens` | provider-reported token counts |

Raw token counts only. **No cost is ever sent**; the platform computes cost from its
price table. Model span names come from the instrumentation (for example
`chat gpt-4o-mini`) and are not part of the contract: the platform identifies model
spans by their `gen_ai.*` attributes.

Prompt and answer text is sent only when `captureContent` / `INDRATRACE_CAPTURE_CONTENT`
is on.

### Session and user

`session({ sessionId, userId }, fn)` puts `session.id` and `user.id` on every span
started inside it. They are span attributes only: never resource attributes, never
metric labels (unbounded values).

## Logs

Log records from `console` (info, warn and error; `console.debug` and `console.trace`
are not sent), pino, winston, bunyan and log4js. Each record carries the severity, the
message, and the trace and span id that were active when it was written. log4js records
also carry `log4js.category`. A line is sent once, even when a logging library prints
it through `console`. The package's own diagnostics are written to stderr and are never
sent.

## Metrics

Whatever the HTTP instrumentation records (request counts and durations), exported every
60 seconds. The package defines no metrics of its own.

## Environment variables

| Variable | Meaning |
|---|---|
| `INDRATRACE_API_KEY` | the API key (required) |
| `INDRATRACE_ENDPOINT` | gateway base URL, no path (self-hosted / development only) |
| `INDRATRACE_DEBUG` | print the startup banner and every export result |
| `INDRATRACE_CAPTURE_CONTENT` | send prompt and answer text |
| `INDRATRACE_PREFLIGHT` | `warn` (default), `strict` (startup check failure rejects), `0` (skip) |

On/off variables are on for `1`, `true`, `yes` or `on`.
