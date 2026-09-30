# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). npm version numbers can never be
reused, so every fix ships as a new version.

## [0.1.0] - 2026-09-30

First release: the Node.js twin of the Python `indratrace` package, following
the same attribute contract.

### Added
- `initObservability()`: traces, logs and metrics over OTLP/HTTP to the IndraTrace
  ingest gateway. The API key is the only configuration.
- `indratrace/register` for `node --import` (ESM) and `node --require` (CommonJS).
- `traceAgent`, `traceTool`, `traceStep`, `session`, `recordFeedback`,
  `currentTraceId`, `recordLlmUsage`, `shutdown`.
- Automatic spans for `node:http`, `fetch`, Express and Fastify; model spans with
  token counts for OpenAI and Anthropic; `console`, pino, winston, bunyan and
  log4js logs linked to traces.
- A startup preflight and export-failure diagnoses in plain words, with the key
  redacted everywhere.
