import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Socket } from "node:net";
import { vi } from "vitest";
import { fauxAssistantMessage, type FauxProviderHandle, type FauxResponseStep } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TelePiConfig } from "../../src/config.js";

/** Sequential-use fixture: no ambient auth, settings, sessions, network or executable shell. */
export function createSdkFixture() {
  const environment = { ...process.env };
  const root = mkdtempSync(path.join(tmpdir(), "telepi-sdk-1-1-0-"));
  const home = path.join(root, "home");
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "configured");
  const savedWorkspace = path.join(root, "saved");
  const shellPath = path.join(root, "recording-shell");
  const shellLog = path.join(root, "shell.jsonl");
  const providerKey = `telepi-fixture:${root}`;
  const globals = globalThis as unknown as Record<string, FauxProviderHandle | undefined>;
  const resources: Array<() => Promise<unknown>> = [];
  const networkSpy = vi.fn();
  const fetchSpy = vi.fn(async () => {
    networkSpy();
    throw new Error("Unexpected fixture network request");
  });
  const originalFetch = globalThis.fetch;
  const socketSpy = vi.spyOn(Socket.prototype, "connect").mockImplementation(() => {
    networkSpy();
    throw new Error("Unexpected fixture socket connection");
  });

  try {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TMPDIR", "TEMP", "TMP"]) {
      if (environment[key] !== undefined) process.env[key] = environment[key];
    }
    Object.assign(process.env, { HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    for (const directory of [home, agentDir, workspace, savedWorkspace]) mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(agentDir, "auth.json"), "{}");
    writeFileSync(path.join(agentDir, "models.json"), '{"providers":{}}');
    writeFileSync(shellPath, `#!/usr/bin/env node\nrequire("node:fs").appendFileSync(${JSON.stringify(shellLog)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.exit(0);\n`);
    chmodSync(shellPath, 0o700);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({
      defaultProvider: "telepi-fixture", defaultModel: "override", defaultThinkingLevel: "off",
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
      enableInstallTelemetry: false, enableAnalytics: false,
      packages: [], skills: [], prompts: [], themes: [],
    }));
    mkdirSync(path.join(agentDir, "extensions"));
    writeFileSync(path.join(agentDir, "extensions", "offline.ts"), `
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function extension(pi: ExtensionAPI) {
  const faux = fauxProvider({ provider: "telepi-fixture", api: "telepi-fixture-api", tokensPerSecond: 0,
    models: [{ id: "saved" }, { id: "override" }] });
  // Import and exercise the real public constructors, not a provider/session mock.
  faux.setResponses([fauxAssistantMessage(fauxToolCall("fixture-tool", {}), { stopReason: "toolUse" }), fauxAssistantMessage("ready")]);
  globalThis[${JSON.stringify(providerKey)}] = faux;
  pi.registerProvider(faux.provider);
}
`);
    for (const [directory, label] of [[workspace, "configured"], [savedWorkspace, "saved"]]) {
      mkdirSync(path.join(directory, ".pi", "extensions"), { recursive: true });
      writeFileSync(path.join(directory, ".pi", "settings.json"), JSON.stringify({
        shellPath, shellCommandPrefix: "echo fixture-prefix;", defaultModel: label === "saved" ? "saved" : "override",
      }));
      writeFileSync(path.join(directory, ".pi", "extensions", "questions.ts"), `
import { type ExtensionAPI, DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function extension(pi: ExtensionAPI) {
  if (!DefaultResourceLoader) throw new Error("Missing SDK export");
  pi.registerTool({ name: "fixture-tool", label: "Fixture", description: "Synthetic tool", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "fixture-tool-result" }], details: {} }) });
  pi.registerCommand("fixture-workspace", { description: ${JSON.stringify(label)}, handler: async () => { pi.appendEntry("fixture-workspace", ${JSON.stringify(label)}); } });
  pi.registerCommand("fixture-dialog", { description: "Synthetic questions", handler: async (_args, ctx) => {
    pi.appendEntry("fixture-select", await ctx.ui.select("Pick", ["Alpha", "Beta"]));
    pi.appendEntry("fixture-confirm", await ctx.ui.confirm("Continue", "Proceed?"));
    pi.appendEntry("fixture-input", await ctx.ui.input("Reply", "Enter text"));
    pi.appendEntry("fixture-complete", true);
  } });
  let controller: AbortController | undefined;
  for (const kind of ["select", "confirm", "input"] as const) {
    pi.registerCommand("fixture-" + kind, { description: "Cancellable " + kind, handler: async (args, ctx) => {
      controller = new AbortController();
      const options = { signal: controller.signal, ...(args === "timeout" ? { timeout: 1000 } : {}) };
      const value = kind === "select" ? await ctx.ui.select("Pick", ["Alpha", "Beta"], options)
        : kind === "confirm" ? await ctx.ui.confirm("Continue", "Proceed?", options)
        : await ctx.ui.input("Reply", "Enter text", options);
      pi.appendEntry("fixture-" + kind, value);
      pi.appendEntry("fixture-complete", true);
    } });
  }
  pi.registerCommand("fixture-abort-signal", { description: "Abort synthetic controller", handler: async () => { controller?.abort(); } });
}
`);
    }
  } catch (error) {
    restore();
    throw error;
  }

  function restore() {
    delete globals[providerKey];
    globalThis.fetch = originalFetch;
    socketSpy.mockRestore();
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, environment);
    rmSync(root, { recursive: true, force: true });
  }

  return {
    root, home, agentDir, workspace, savedWorkspace, shellPath, shellLog, fetchSpy, networkSpy,
    dialogs: { command: "fixture-dialog", cancellable: { select: "fixture-select", confirm: "fixture-confirm", input: "fixture-input" }, abortSignal: "fixture-abort-signal", timeoutArgs: "timeout" },
    config(overrides: Partial<TelePiConfig> = {}): TelePiConfig {
      return { telegramBotToken: "123456:synthetic-fixture-token", telegramAllowedUserIds: [123], telegramAllowedUserIdSet: new Set([123]),
        workspace, toolVerbosity: "all", promptInboxIntervalMs: 60_000, ...overrides };
    },
    get faux(): FauxProviderHandle {
      const faux = globals[providerKey];
      if (!faux) throw new Error("Fixture provider has not been loaded");
      return faux;
    },
    setResponses(responses: FauxResponseStep[]) {
      this.faux.setResponses(responses);
    },
    shellInvocations(): unknown[] {
      return existsSync(shellLog) ? readFileSync(shellLog, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
    },
    persistSession(modelId = "saved", cwd = savedWorkspace): string {
      const manager = SessionManager.create(cwd, path.join(agentDir, "sessions", "synthetic-history"));
      manager.appendModelChange("telepi-fixture", modelId);
      manager.appendMessage({ role: "user", content: "Synthetic saved history", timestamp: 1 });
      manager.appendMessage({ ...fauxAssistantMessage("Synthetic assistant history"),
        api: "telepi-fixture-api", provider: "telepi-fixture", model: modelId,
      });
      const file = manager.getSessionFile();
      if (!file || !existsSync(file)) throw new Error("Synthetic session was not persisted");
      return file;
    },
    track(dispose: () => Promise<unknown>) { resources.push(dispose); },
    async cleanup() {
      try {
        for (const dispose of resources.reverse()) await dispose();
      } finally {
        restore();
      }
    },
  };
}
