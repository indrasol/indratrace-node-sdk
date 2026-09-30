# indratrace - Node.js SDK

Thin OpenTelemetry wrapper that lets a Node.js product plug into the IndraTrace
platform with one init call or one start flag. Published publicly on npm as
`indratrace`. The platform is the IndraTrace backend (closed source): never import
from or depend on it.

## Stack
- TypeScript (strict), Node >= 20.6, built to ESM + CJS with tsup.
- OpenTelemetry JS 2.x; auto-instrumentation via the official instrumentations,
  `@fastify/otel`, and the Traceloop (OpenLLMetry) instrumentors for OpenAI and
  Anthropic.
- Tests: vitest with in-memory exporters (`test/`), plus `npm run smoke`
  (`dev/smoke/run.mjs`): the packed tarball in a real ESM and CJS app against a
  fake gateway. Patching only happens in a real process, so the smoke run is the
  test for auto-instrumentation.

## The contract
`docs/conventions.md` is the contract with the platform: every attribute name and
transport rule it reads. Treat it as law; change it deliberately, with a CHANGELOG
entry and a test.

## Conventions
- Commit to `main` in small working increments. Conventional Commits.
- The version lives in `package.json` AND `src/version.ts` (a test asserts they
  match; the release workflow refuses a tag that matches neither). npm versions
  can never be reused.
- Secrets: never commit `.env`, tokens or API keys.

## Don't
- Don't let SDK errors reach the host app. The only thrown error is
  `IndraTraceConfigError` at init.
- Don't add policy (sampling, routing, redaction of user data) to the SDK.
- Don't compute cost: raw token counts only.
- Don't send `product`, `deployment.environment` or `tenant.id`: the gateway
  stamps them from the key.
- Don't propagate baggage outbound: session/user ids must not leave in headers.
- Don't add runtime dependencies beyond OpenTelemetry and instrumentors.
