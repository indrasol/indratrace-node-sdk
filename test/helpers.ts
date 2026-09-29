import http from "node:http";
import type { AddressInfo } from "node:net";
import { InMemorySpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { _useExportersForTests, initObservability, shutdown, type InitOptions } from "../src/init.js";
import { state } from "../src/state.js";

export const KEY = "it_live_test_secret_key_123";

/** Init against in-memory exporters; returns a function that flushes and hands back finished spans. */
export async function initInMemory(options: InitOptions = {}) {
  process.env.INDRATRACE_PREFLIGHT = "0";
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  _useExportersForTests({ traces: spans, logs });
  await initObservability({ apiKey: KEY, ...options });
  return {
    spans,
    logs,
    async finished(): Promise<ReadableSpan[]> {
      await state().tracerProvider?.forceFlush();
      return spans.getFinishedSpans();
    },
  };
}

export async function reset(): Promise<void> {
  await shutdown();
  _useExportersForTests({ traces: undefined, logs: undefined });
  delete process.env.INDRATRACE_PREFLIGHT;
}

export interface FakeGateway {
  url: string;
  requests: { path: string; headers: http.IncomingHttpHeaders; body: Buffer }[];
  close(): Promise<void>;
}

/** A local stand-in for the ingest gateway that answers every request with `status`/`body`. */
export async function fakeGateway(status: number, body = "", contentType = "application/problem+json"): Promise<FakeGateway> {
  const requests: FakeGateway["requests"] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      requests.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status, { "content-type": contentType });
      res.end(body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** Capture everything the SDK prints to stderr. */
export function captureConsole() {
  const lines: string[] = [];
  const orig = { warn: console.warn, error: console.error };
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  console.error = (...a: unknown[]) => lines.push(a.join(" "));
  return {
    lines,
    restore() {
      Object.assign(console, orig);
    },
  };
}
