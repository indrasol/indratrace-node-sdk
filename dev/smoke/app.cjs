// The smoke app, as a customer's CommonJS service. Run by dev/smoke/run.mjs with
// `node --require indratrace/register app.cjs`. Same app as app.mjs.
const express = require("express");
const { OpenAI } = require("openai");
const { Anthropic } = require("@anthropic-ai/sdk");
const pino = require("pino");
const log4js = require("log4js");
const bunyan = require("bunyan");
const { traceAgent, traceTool, session, shutdown } = require("indratrace");

const fake = (body) => async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const openai = new OpenAI({
  apiKey: "sk-test",
  fetch: fake({
    id: "c1", object: "chat.completion", created: 1, model: "gpt-4o-mini",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "SECRET_ANSWER" } }],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }),
});
const anthropic = new Anthropic({
  apiKey: "sk-ant-test",
  fetch: fake({
    id: "m1", type: "message", role: "assistant", model: "claude-haiku-4-5",
    content: [{ type: "text", text: "SECRET_ANSWER" }], stop_reason: "end_turn",
    usage: { input_tokens: 13, output_tokens: 5 },
  }),
});
// pino and bunyan write nowhere locally; log4js prints through console.log. All are shipped.
const logger = pino({ enabled: true }, { write() {} });
log4js.configure({ appenders: { out: { type: "console" } }, categories: { default: { appenders: ["out"], level: "info" } } });
const l4 = log4js.getLogger("smoke");
const bun = bunyan.createLogger({ name: "smoke", streams: [{ stream: { write() {} } }] });

const lookup = traceTool(async function lookup(q) {
  return q.length;
});
const agent = traceAgent("smoke-agent", async (q) => {
  logger.info("pino line");
  l4.info("log4js line"); // prints through console.log: must still arrive once
  bun.info("bunyan line");
  console.log("console line");
  await lookup(q);
  await openai.chat.completions.create({ model: "gpt-4o-mini", messages: [{ role: "user", content: "SECRET_PROMPT " + q }] });
  await anthropic.messages.create({ model: "claude-haiku-4-5", max_tokens: 10, messages: [{ role: "user", content: "SECRET_PROMPT " + q }] });
});

const app = express();
app.get("/ask", async (_req, res) => {
  await session({ sessionId: "conv-smoke", userId: "u-smoke" }, () => agent("hello"));
  res.send("ok");
});
const server = app.listen(0, "127.0.0.1", async () => {
  await fetch(`http://127.0.0.1:${server.address().port}/ask`);
  server.close();
  await shutdown();
});
