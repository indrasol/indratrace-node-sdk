<h1 align="center">
  <img src="https://raw.githubusercontent.com/indrasol/indratrace-node-sdk/main/assets/indrabot-mascot.png" width="64" align="center" alt="Indrabot">
  IndraTrace SDK for Node.js
</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/indratrace"><img alt="npm version" src="https://img.shields.io/npm/v/indratrace.svg"></a>
  <a href="https://github.com/indrasol/indratrace-node-sdk/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/indrasol/indratrace-node-sdk/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/indrasol/indratrace-node-sdk/blob/main/LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
</p>

OpenTelemetry-native observability for the IndraTrace platform: one line for
web apps and AI agents. Traces, logs, metrics, and model-call token usage, all
in one trace tree.

```bash
npm install indratrace
```

```bash
INDRATRACE_API_KEY=it_live_... node --import indratrace/register app.js
```

That is the whole integration. **The API key is the only thing you configure.**
It identifies your product, its environment and your workspace, all decided when
you register the product and copy its key. And if something *is* wrong (the key,
the network, your billing), the SDK tells you which, in one sentence, at startup.

Two words to know up front:

- A **span** is one timed step: a web request, a database call, one model call.
- A **trace** is the full story of one request: its spans stacked on a
  timeline, so you can see where the time went and what called what.

## Starting it: pick one

Tracing works by patching libraries **as they load**, so the SDK has to start
before your app imports Express, OpenAI and the rest.

**1. The start flag (recommended).** One line for every app, whether it uses
`import` (ES modules) or `require` (CommonJS). Nothing changes in your code:

```bash
node --import indratrace/register app.js
```

It reads the key from `INDRATRACE_API_KEY`. In a `package.json` script:
`"start": "node --import indratrace/register app.js"`. In a Dockerfile:
`ENV NODE_OPTIONS="--import indratrace/register"`. On Windows PowerShell, set the
key first: `$env:INDRATRACE_API_KEY="it_live_..."`, then run the same `node` line.

(A tool that only accepts `--require` can use `node --require indratrace/register
app.js` for a CommonJS app; it does the same thing.)

**2. In code.** Call it first, in a file of its own that runs before anything else:

```js
// instrumentation.js
import { initObservability } from "indratrace";
initObservability({ apiKey: process.env.INDRATRACE_API_KEY });
```

```bash
node --import ./instrumentation.js app.js
```

> **Using ES modules?** `import` statements are hoisted: they all run before any
> line of code in the same file. So `initObservability()` written at the top of
> `app.js`, above `import express from "express"`, still runs **after** Express
> has loaded, and Express produces no spans. Use option 1, or put the call in its
> own file loaded with `--import` as shown. If a library did load too early, the
> SDK prints a warning naming it.

## Wrapping your agents and tools

```js
import express from "express";
import { traceAgent, traceTool, traceStep } from "indratrace";

const riskScore = traceTool(async function riskScore(vendor) { ... });   // span "tool riskScore"
const parse = traceStep(function parseVendor(raw) { ... });             // span "step parseVendor"

const run = traceAgent("compliance-checker", async (query) => {         // span "agent compliance-checker"
  return riskScore(parse(query));
});

const app = express();              // every HTTP request becomes a span, automatically
app.post("/check", async (req, res) => res.json(await run(req.body.query)));
```

- `traceAgent(name, fn)`, `traceTool(fn)` and `traceStep(fn)` return a function
  with the same signature. Sync and async both work.
- The span name comes from the function's name, or pass one:
  `traceTool("search", fn)`.
- An error is recorded on the span, marked as failed, and re-thrown **unchanged**.
  If tracing itself fails, your function still runs.
- `traceStep` is for plain work (a query, a parser) that isn't an AI "tool".

## What you get automatically

| What | Captured |
|---|---|
| Incoming HTTP (`node:http`) | a server span per request |
| Express, Fastify | route-level spans (`http.route`) |
| Outgoing `fetch` and `http` | client spans, with trace context passed downstream |
| OpenAI, Anthropic | a span per model call, with exact token counts |
| `console.log` / `info` / `warn` / `error` | every line at INFO and above (`console.debug` stays local), linked to the trace it was written in |
| pino, winston, bunyan, log4js | every log line, linked to the trace it was written in |

Everything lands in **one trace**: request → route → your agent → tools → model
calls, with the logs attached. Metrics from the HTTP instrumentation are sent too.

Logs still print to the terminal exactly as before; they are *also* sent. A line
that a logging library prints through `console` (log4js's console appender, for
example) is sent once, not twice. Browser logs are not covered: this package runs
on the server.

Calls to your other services carry the trace id in the standard `traceparent`
header, so a Node.js service calling another traced service continues the same
trace.

## Token usage from model calls

OpenAI and Anthropic calls are traced with no code. Each model span carries
`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens` and `gen_ai.usage.total_tokens`, the numbers the
provider bills on. The SDK records raw counts only and **never computes cost**;
the platform does that from its price table.

For any other provider, stamp the counts yourself inside a traced function:

```js
import { recordLlmUsage, traceTool } from "indratrace";

const callMistral = traceTool(async function callMistral(prompt) {
  const r = await mistral.chat({ model: "mistral-large", messages: [{ role: "user", content: prompt }] });
  recordLlmUsage("mistral-large", r.usage.promptTokens, r.usage.completionTokens, { system: "mistral" });
  return r;
});
```

### Capturing prompt and completion text

Off by default, because prompts carry customer data. Turn it on with
`initObservability({ captureContent: true })` or `INDRATRACE_CAPTURE_CONTENT=1`.
The text then lands on model spans as `gen_ai.input.messages` /
`gen_ai.output.messages`. Token counts are captured either way.

## Session and user context

```js
import { session } from "indratrace";

app.use((req, res, next) =>
  session({ sessionId: req.get("x-session-id"), userId: req.user?.id }, next),
);
```

Every span started inside, including HTTP and model spans, carries `session.id`
and `user.id`. Either id is optional, and nesting overrides per key. The ids stay
inside IndraTrace: they are **not** forwarded to the services you call.

## Feedback (👍 / 👎)

```js
import { currentTraceId, recordFeedback } from "indratrace";

const traceId = currentTraceId();          // capture it while answering
// ... later, when the user clicks 👍
recordFeedback(1, { traceId, comment: "spot on" });
```

`1` is positive, `0` or `-1` negative, or use any numeric scale.

## Shutting down

Buffered telemetry is flushed automatically when a script's event loop empties.
A server that exits on a signal should flush first:

```js
import { shutdown } from "indratrace";
process.on("SIGTERM", async () => { await shutdown(); process.exit(0); });
```

## Configuration

| Setting | Option | Env var | Default |
|---|---|---|---|
| API key (required) | `apiKey` | `INDRATRACE_API_KEY` | none: startup throws `IndraTraceConfigError` |
| Service name | `serviceName` | `OTEL_SERVICE_NAME` | `unknown_service` |
| Service version | `serviceVersion` | | `0.0.0` |
| Prompt/completion text | `captureContent` | `INDRATRACE_CAPTURE_CONTENT` | off |
| Diagnostics | `debug` | `INDRATRACE_DEBUG` | off |
| Startup check | | `INDRATRACE_PREFLIGHT` | `warn` (`strict` fails, `0` skips) |
| Gateway URL | | `INDRATRACE_ENDPOINT` | `https://ingest.indratrace.com` |

- Env var flags are on for `1`, `true`, `yes` or `on`. An option you pass wins over the env var.
- **You never set product, environment or tenant.** IndraTrace stamps them from
  the key when the telemetry arrives.
- `INDRATRACE_ENDPOINT` is only for self-hosted gateways and IndraTrace's own
  dev environment. Customers of the hosted service never set it.

### What it checks at startup

`initObservability()` makes one short, authenticated request to the gateway. If
it doesn't get a 2xx, it logs **one paragraph naming the cause**:

- the hostname doesn't resolve
- outbound traffic is blocked (a firewall, NSG or proxy on port 443)
- nothing is listening at a localhost endpoint
- a TLS-intercepting proxy
- a rejected key (401)
- no card on file, or the account is suspended (402)
- the endpoint isn't the gateway (404)

Your app keeps running either way. After startup, exports are watched: three
failed batches in a row log the same diagnosis once, then at most every five
minutes, and recovery logs one line. The key is never printed.

`initObservability()` returns a promise that settles when these startup checks
finish. You don't need to await it. With `INDRATRACE_PREFLIGHT=strict` the
promise rejects instead, so a CI job fails rather than booting a service that
drops its telemetry.

## Still waiting for your first span?

1. Run with `INDRATRACE_DEBUG=1`. The banner lists every instrumentation, and
   each export prints `export ok` or `export FAILED` with the reason.
2. Look for a warning like `express loaded before initObservability()`. If you
   see one, start the app with `--import indratrace/register`.
3. A `401` means the key: check the running process for a trailing newline or a
   truncated paste.

## Requirements

Node.js 20.6 or newer. ESM and CommonJS are both supported. TypeScript types are included.

## Contributing

```bash
npm install
npm test          # unit tests
npm run smoke     # packs the package and runs a real app against a fake gateway
```

Everything this package sends, attribute by attribute, is documented in
[`docs/conventions.md`](docs/conventions.md).
Security reports: see [SECURITY.md](SECURITY.md). Licensed under Apache-2.0.
