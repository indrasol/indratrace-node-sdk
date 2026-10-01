# Changelog

All notable changes to this package are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). npm version numbers can never be
reused, so every fix ships as a new version.

## [Unreleased]

### Added
- The app's release number (`service.version`) is found automatically, so the
  one-line `--import indratrace/register` start carries it with no option: the
  `serviceVersion` option, else `service.version` in `OTEL_RESOURCE_ATTRIBUTES`,
  else the app's own `package.json` `version`, else `0.0.0` (not set). The debug
  banner names where it came from.

### Changed
- The package documents its own contract with the platform in
  `docs/conventions.md` (every attribute name and transport rule), and the README
  links there. The README logo is served from this repository.
- The README gives one start line for every app, `node --import indratrace/register
  app.js`, which works for CommonJS apps too; `--require` remains an alternative.

## [0.1.0] - 2026-09-30

First release: the one-line OpenTelemetry setup for IndraTrace. What it sends is
documented in `docs/conventions.md`.

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
