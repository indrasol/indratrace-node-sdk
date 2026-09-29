// End-to-end smoke test of the PACKED package, as a customer installs it.
//
//   node dev/smoke/run.mjs
//
// Packs the repo, installs the tarball plus express/openai/@anthropic-ai/sdk/pino
// into a temp project, runs a small app as ESM (--import indratrace/register) and
// as CJS (--require indratrace/register) against a fake ingest gateway, decodes
// the OTLP protobuf it receives, and asserts the contract. The unit tests cannot
// cover this: module patching only happens in a real Node process.
// Needs network for npm install. Exits 1 on the first failed assertion.
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(fileURLToPath(import.meta.url), "../../..");
const here = join(repo, "dev", "smoke");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = (args, cwd) => execFileSync(npm, args, { cwd, stdio: ["ignore", "pipe", "inherit"], shell: process.platform === "win32" }).toString();
const KEY = "it_live_smoke_test_key";

const work = mkdtempSync(join(tmpdir(), "indratrace-smoke-"));
try {
  const tgz = sh(["pack", "--silent", "--pack-destination", work], repo).trim().split(/\r?\n/).pop();
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
  for (const f of readdirSync(here).filter((f) => f.startsWith("app."))) cpSync(join(here, f), join(work, f));
  sh(["install", "--no-audit", "--no-fund", join(work, tgz), "express", "openai", "@anthropic-ai/sdk", "pino"], work);

  for (const [mode, args] of [
    ["esm", ["--import", "indratrace/register", "app.mjs"]],
    ["cjs", ["--require", "indratrace/register", "app.cjs"]],
  ]) {
    const received = [];
    const gateway = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        received.push({ path: req.url, key: req.headers["x-indratrace-key"], body: Buffer.concat(chunks) });
        res.writeHead(200).end();
      });
    });
    await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
    const endpoint = `http://127.0.0.1:${gateway.address().port}`;
    const code = await new Promise((r) =>
      spawn(process.execPath, args, {
        cwd: work,
        stdio: ["ignore", "ignore", "inherit"],
        env: { ...process.env, INDRATRACE_API_KEY: KEY, INDRATRACE_ENDPOINT: endpoint },
      }).on("exit", r),
    );
    gateway.close();
    assert.equal(code, 0, `${mode}: app exited ${code}`);
    check(mode, received);
    console.log(`smoke ${mode}: ok`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

function check(mode, received) {
  const { spans, logs, resource } = decode(received);
  const where = `${mode}: `;
  assert.ok(received.length > 0, where + "nothing reached the gateway");
  assert.ok(received.every((r) => r.key === KEY), where + "a request lacked the x-indratrace-key header");
  const byName = (n) => spans.find((s) => s.name === n) ?? assert.fail(`${where}no span "${n}"; got ${spans.map((s) => s.name)}`);

  const agent = byName("agent smoke-agent");
  const openai = byName("chat gpt-4o-mini");
  const anthropic = byName("chat claude-haiku-4-5");
  const route = spans.find((s) => s.attrs["http.route"] === "/ask") ?? assert.fail(where + "no express span with http.route=/ask");
  byName("tool lookup");

  assert.equal(spans.filter((s) => s.name.startsWith("chat ")).length, 2, where + "each model call must produce exactly one span");
  assert.equal(new Set(spans.map((s) => s.traceId)).size, 1, where + "all spans must share one trace");
  assert.equal(logs.length, 1, where + "expected the one pino line");
  assert.equal(logs[0].traceId, agent.traceId, where + "the log must carry the trace id");

  assert.equal(agent.attrs["indratrace.span.kind"], "agent");
  assert.equal(agent.attrs["session.id"], "conv-smoke");
  assert.equal(openai.attrs["gen_ai.provider.name"], "openai");
  assert.equal(openai.attrs["gen_ai.usage.input_tokens"], 11);
  assert.equal(openai.attrs["gen_ai.usage.output_tokens"], 7);
  assert.equal(anthropic.attrs["gen_ai.provider.name"], "anthropic");
  assert.equal(anthropic.attrs["gen_ai.usage.input_tokens"], 13);
  assert.equal(anthropic.attrs["session.id"], "conv-smoke");
  assert.ok(route, where + "express route span");

  assert.match(resource["telemetry.sdk.wrapper"], /^indratrace-js\/\d+\.\d+\.\d+/);
  const raw = Buffer.concat(received.map((r) => r.body)).toString("latin1");
  for (const k of ["tenant.id", "deployment.environment"]) assert.ok(!raw.includes(k), `${where}sent gateway-stamped ${k}`);
  assert.ok(!/SECRET_(PROMPT|ANSWER)/.test(raw), where + "prompt/answer text sent with capture off");
  assert.ok(!/cost/i.test(raw), where + "a cost attribute was sent");
}

// Minimal OTLP protobuf reader: only the fields the checks need.
function* fields(buf) {
  let i = 0;
  const varint = () => {
    let r = 0n, s = 0n;
    for (;;) { const b = buf[i++]; r |= BigInt(b & 0x7f) << s; s += 7n; if (!(b & 0x80)) return r; }
  };
  while (i < buf.length) {
    const tag = Number(varint()), no = tag >> 3, wt = tag & 7;
    if (wt === 0) yield [no, wt, varint()];
    else if (wt === 2) { const n = Number(varint()); yield [no, wt, buf.subarray(i, i + n)]; i += n; }
    else if (wt === 1) { yield [no, wt, buf.subarray(i, i + 8)]; i += 8; }
    else if (wt === 5) { yield [no, wt, buf.subarray(i, i + 4)]; i += 4; }
    else throw new Error("unexpected wire type " + wt);
  }
}
function sub(b, n) {
  return b ? [...fields(b)].filter(([f, w]) => f === n && w === 2).map(([, , v]) => v) : [];
}
function attrs(kvs) {
  const o = {};
  for (const kv of kvs) {
    const key = sub(kv, 1)[0]?.toString();
    for (const [f, , v] of fields(sub(kv, 2)[0] ?? Buffer.alloc(0))) o[key] = f === 1 ? v.toString() : f === 3 ? Number(v) : v;
  }
  return o;
}
function decode(received) {
  const spans = [], logs = [];
  let resource = {};
  for (const r of received) {
    if (r.path === "/v1/traces") for (const rs of sub(r.body, 1)) {
      resource = attrs(sub(sub(rs, 1)[0], 1));
      for (const ss of sub(rs, 2)) for (const sp of sub(ss, 2))
        spans.push({ traceId: sub(sp, 1)[0]?.toString("hex"), name: sub(sp, 5)[0]?.toString(), attrs: attrs(sub(sp, 9)) });
    }
    if (r.path === "/v1/logs") for (const rl of sub(r.body, 1)) for (const sl of sub(rl, 2)) for (const lr of sub(sl, 2))
      logs.push({ body: sub(sub(lr, 5)[0], 1)[0]?.toString(), traceId: sub(lr, 9)[0]?.toString("hex") });
  }
  return { spans, logs, resource };
}
