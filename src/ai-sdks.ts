/**
 * Gap-filler for the OpenAI and Anthropic instrumentors, applied lazily at the
 * moment the app loads either SDK.
 *
 * The Traceloop instrumentors do the real work, but two loads escape their own hook:
 *  - ESM builds (`import OpenAI from "openai"`): they bundle an older
 *    @opentelemetry/instrumentation whose import hook cannot run beside ours.
 *  - CommonJS builds outside their declared version range (openai 7+ today, where
 *    the API they patch is unchanged).
 * This instrumentation uses OUR hooks (require and import), and for exactly those
 * two cases hands the loaded module to the instrumentor's manuallyInstrument(), the
 * route Traceloop documents for ESM. Every other load is left to the instrumentor's
 * own hook, so nothing is wrapped twice. Prototype patches cover clients created later.
 */
import {
  InstrumentationBase,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  type InstrumentationConfig,
} from "@opentelemetry/instrumentation";
import { createRequire } from "node:module";
import { VERSION } from "./version.js";

export interface Patchable {
  manuallyInstrument(m: unknown): void;
  unpatch(m: unknown): void;
}

interface AiSdkConfig extends InstrumentationConfig {
  openai?: Patchable;
  anthropic?: Patchable;
}

interface Target {
  module: string;
  key: "openai" | "anthropic";
  /** Major versions the instrumentor's own require hook already patches. */
  hookedMajors(major: number): boolean;
  cls(m: any): any;
  create(cls: any): unknown;
  /** What manuallyInstrument() takes, and what unpatch() takes. */
  patchArg(cls: any): unknown;
  unpatchArg(cls: any): unknown;
  /**
   * The internal ESM file that defines the client class. import-in-the-middle
   * never reports the main module of a SCOPED package on Windows (it compares a
   * `/` specifier against a `\` path), but it does report internal files.
   */
  esmFile?: string;
}

const TARGETS: Target[] = [
  {
    module: "openai",
    key: "openai",
    hookedMajors: (m) => m >= 4 && m < 7, // @traceloop/instrumentation-openai: ">=4 <7"
    cls: (m) => m?.OpenAI ?? m?.default,
    create: (cls) => cls?.Chat?.Completions?.prototype?.create,
    patchArg: (cls) => cls,
    unpatchArg: (cls) => ({ OpenAI: cls }),
  },
  {
    module: "@anthropic-ai/sdk",
    key: "anthropic",
    hookedMajors: () => true, // @traceloop/instrumentation-anthropic: ">=0.9.1"
    cls: (m) => m?.Anthropic ?? m?.default,
    create: (cls) => cls?.Messages?.prototype?.create,
    patchArg: (cls) => ({ Anthropic: cls }),
    unpatchArg: (cls) => ({ Anthropic: cls }),
    esmFile: "@anthropic-ai/sdk/client.mjs",
  },
];

/**
 * A CommonJS load hands over the very exports object that sits in the require
 * cache; the import hook hands over its own wrapper, which never does. Checked
 * once per load of the two SDKs.
 */
function isCommonJs(m: unknown): boolean {
  const cache = createRequire(import.meta.url).cache;
  return Object.values(cache).some((mod) => mod?.exports === m);
}

export class AiSdkInstrumentation extends InstrumentationBase<AiSdkConfig> {
  private readonly patched = new Map<Target, unknown>();

  constructor(config: AiSdkConfig) {
    super("indratrace-ai-sdks", VERSION, config);
  }

  protected init() {
    return TARGETS.map(
      (t) =>
        new InstrumentationNodeModuleDefinition(
          t.module,
          ["*"],
          (m: unknown, version?: string) => this.patch(t, m, version),
          () => this.unpatch(t),
          t.esmFile
            ? [
                new InstrumentationNodeModuleFile(
                  t.esmFile,
                  ["*"],
                  (m: unknown, version?: string) => this.patch(t, m, version) as never,
                  () => this.unpatch(t),
                ),
              ]
            : [],
        ),
    );
  }

  private patch(t: Target, m: unknown, version?: string): unknown {
    try {
      const inst = this.getConfig()[t.key];
      if (!inst) return m;
      if (isCommonJs(m) && t.hookedMajors(Number(version?.split(".")[0]))) return m; // its own hook has it
      const cls = t.cls(m);
      const create = t.create(cls);
      if (typeof create !== "function" || (create as { __wrapped?: boolean }).__wrapped) return m;
      inst.manuallyInstrument(t.patchArg(cls));
      this.patched.set(t, cls);
    } catch {
      // never break the app's import
    }
    return m;
  }

  private unpatch(t: Target): void {
    const cls = this.patched.get(t);
    const inst = this.getConfig()[t.key];
    if (cls === undefined || !inst) return;
    try {
      inst.unpatch(t.unpatchArg(cls));
    } catch {
      // best-effort
    }
    this.patched.delete(t);
  }

  override disable(): void {
    super.disable();
    for (const t of TARGETS) this.unpatch(t);
  }
}
