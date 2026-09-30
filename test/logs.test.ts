import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import { currentTraceId, traceTool } from "../src/index.js";
import { log } from "../src/log.js";
import { state } from "../src/state.js";
import { captureConsole, initInMemory, reset } from "./helpers.js";

afterEach(reset);
const require = createRequire(import.meta.url);

async function records(t: Awaited<ReturnType<typeof initInMemory>>) {
  await state().loggerProvider?.forceFlush();
  return t.logs.getFinishedLogRecords();
}

describe("console capture", () => {
  it("ships console.log/info/warn/error, linked to the active trace", async () => {
    const t = await initInMemory();
    let traceId: string | undefined;
    traceTool(function handler() {
      traceId = currentTraceId();
      console.log("order %s placed", "A-17");
      console.warn("slow payment provider");
      console.error(new Error("card declined").message);
    })();
    const got = await records(t);
    const byBody = (b: string) => got.find((r) => r.body === b);
    expect(byBody("order A-17 placed")?.severityText).toBe("info");
    expect(byBody("slow payment provider")?.severityText).toBe("warn");
    expect(byBody("card declined")?.severityText).toBe("error");
    expect(byBody("order A-17 placed")?.spanContext?.traceId).toBe(traceId);
  });

  it("keeps console.debug local (INFO and above only)", async () => {
    const t = await initInMemory();
    console.debug("noisy detail");
    expect((await records(t)).some((r) => r.body === "noisy detail")).toBe(false);
  });

  it("never ships the SDK's own diagnostics", async () => {
    const t = await initInMemory();
    const out = captureConsole();
    try {
      log.warn("an SDK warning");
    } finally {
      out.restore();
    }
    expect(out.lines.some((l) => l.includes("an SDK warning"))).toBe(true);
    expect((await records(t)).some((r) => String(r.body).includes("an SDK warning"))).toBe(false);
  });

  it("stops capturing after shutdown", async () => {
    const t = await initInMemory();
    const logs = t.logs;
    await reset();
    console.log("after shutdown");
    expect(logs.getFinishedLogRecords().some((r) => r.body === "after shutdown")).toBe(false);
  });
});

describe("log4js", () => {
  it("ships each event once, even through log4js's console appender", async () => {
    const t = await initInMemory();
    const log4js = require("log4js");
    log4js.configure({ appenders: { out: { type: "console" } }, categories: { default: { appenders: ["out"], level: "info" } } });
    const logger = log4js.getLogger("billing");
    traceTool(function charge() {
      logger.info("charged %d cents", 1250);
      logger.debug("below the configured level");
    })();
    const got = (await records(t)).filter((r) => String(r.body).includes("charged"));
    expect(got).toHaveLength(1);
    expect(got[0]!.body).toBe("charged 1250 cents");
    expect(got[0]!.severityText).toBe("INFO");
    expect(got[0]!.attributes["log4js.category"]).toBe("billing");
    expect(got[0]!.spanContext?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect((await records(t)).some((r) => String(r.body).includes("below the configured level"))).toBe(false);
    log4js.shutdown();
  });
});

describe("bunyan", () => {
  it("ships records, linked to the active trace", async () => {
    const t = await initInMemory();
    const bunyan = require("bunyan");
    const logger = bunyan.createLogger({ name: "api", streams: [{ stream: { write() {} }, level: "info" }] });
    traceTool(function handle() {
      logger.info({ orderId: "A-17" }, "bunyan line");
    })();
    const got = (await records(t)).find((r) => r.body === "bunyan line");
    expect(got?.spanContext?.traceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
