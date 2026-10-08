import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import registerHandoff, {
  getInstalledConfigPath,
  getInstalledLaunchAgentPath,
  getInstalledSystemdServicePath,
  hasInstalledSystemdFlow,
  resolveDirectLaunchTarget,
  resolveHandoffMode,
} from "../extensions/telepi-handoff.ts";

describe("handoff extension helpers", () => {
  it("uses only ExtensionUIContext-supported notification severities", () => {
    const source = readFileSync(new URL("../extensions/telepi-handoff.ts", import.meta.url), "utf8");

    expect(source).not.toContain('"success"');
  });

  const originalEnv = process.env;
  const originalPlatform = process.platform;
  let tempDir: string;
  let homeDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "telepi-handoff-"));
    homeDir = path.join(tempDir, "home");
    mkdirSync(homeDir, { recursive: true });

    process.env = {
      ...originalEnv,
      HOME: homeDir,
    };
    delete process.env.TELEPI_HANDOFF_MODE;
    delete process.env.TELEPI_DIR;
    delete process.env.TELEPI_LAUNCHD_LABEL;
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it.each(["direct", "launchd", "systemd"] as const)("awaits successful %s launch before CLI shutdown", async (mode) => {
    process.env.TELEPI_HANDOFF_MODE = mode;
    process.env.TELEPI_DIR = path.join(tempDir, "source");
    const sessionFile = path.join(tempDir, "synthetic-session.jsonl");
    writeFileSync(sessionFile, "synthetic persisted history\n");
    const order: string[] = [];
    let finishLaunch!: () => void;
    const gate = new Promise<void>((resolve) => { finishLaunch = resolve; });
    let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
    const exec = vi.fn(async (_command: string, args: string[]) => {
      const script = args[1]!;
      if (script.includes("command -v telepi")) return { code: 1, stdout: "", stderr: "", killed: false };
      if (script.includes("pkill")) return { code: 0, stdout: "", stderr: "", killed: false };
      order.push("launch-start");
      await gate;
      order.push("launch-finished");
      return { code: 0, stdout: "12345\n", stderr: "", killed: false };
    });
    registerHandoff({ exec, registerCommand: (_name, command) => { handler = command.handler; } } as unknown as ExtensionAPI);
    const shutdown = vi.fn(() => { order.push("shutdown"); });
    const pending = handler("", { sessionManager: { getSessionFile: () => sessionFile }, ui: { notify: vi.fn() }, shutdown } as any);
    try {
      await vi.waitFor(() => expect(order).toEqual(["launch-start"]));
      expect(shutdown).not.toHaveBeenCalled();
      expect(exec.mock.calls.at(-1)![1][1]).toContain(sessionFile);
    } finally {
      finishLaunch();
      await pending;
    }
    expect(order).toEqual(["launch-start", "launch-finished", "shutdown"]);
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it.each(["direct", "launchd", "systemd"] as const)("keeps CLI alive after failed %s launch", async (mode) => {
    process.env.TELEPI_HANDOFF_MODE = mode;
    process.env.TELEPI_DIR = path.join(tempDir, "source");
    const sessionFile = path.join(tempDir, "synthetic-session.jsonl");
    writeFileSync(sessionFile, "synthetic persisted history\n");
    for (const failure of ["nonzero", "throw"] as const) {
      let handler!: Parameters<ExtensionAPI["registerCommand"]>[1]["handler"];
      const exec = vi.fn(async (_command: string, args: string[]) => {
        if (args[1]!.includes("command -v telepi")) return { code: 1, stdout: "", stderr: "", killed: false };
        if (args[1]!.includes("pkill")) return { code: 0, stdout: "", stderr: "", killed: false };
        if (failure === "throw") throw new Error("Synthetic launch failure");
        return { code: 1, stdout: "", stderr: "Synthetic launch failure", killed: false };
      });
      registerHandoff({ exec, registerCommand: (_name, command) => { handler = command.handler; } } as unknown as ExtensionAPI);
      const shutdown = vi.fn();
      const notify = vi.fn();
      await handler("", { sessionManager: { getSessionFile: () => sessionFile }, ui: { notify }, shutdown } as any);
      expect(shutdown).not.toHaveBeenCalled();
      expect(notify).toHaveBeenLastCalledWith(expect.any(String), "warning");
    }
  });

  // --- macOS / launchd tests ---

  it("defaults to launchd after telepi setup assets are present", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledLaunchAgentPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledLaunchAgentPath(), "<plist/>\n");

    expect(resolveHandoffMode()).toBe("launchd");
  });

  it("defaults to direct for source-checkout usage", () => {
    process.env.TELEPI_DIR = "/tmp/TelePi";

    expect(resolveHandoffMode()).toBe("direct");
  });

  it("allows explicit direct override even when installed assets are present", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledLaunchAgentPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledLaunchAgentPath(), "<plist/>\n");
    process.env.TELEPI_HANDOFF_MODE = "direct";

    expect(resolveHandoffMode()).toBe("direct");
  });

  it("falls back to TELEPI_DIR when global telepi lacks installed config", () => {
    const target = resolveDirectLaunchTarget({
      hasGlobalTelePi: true,
      telePiDir: "  /tmp/TelePi  ",
    });

    expect(target).toEqual({
      kind: "source",
      telePiDir: "/tmp/TelePi",
    });
  });

  it("uses the installed direct target only when the installed config exists", () => {
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");

    expect(resolveDirectLaunchTarget({ hasGlobalTelePi: true, telePiDir: "/tmp/TelePi" })).toEqual({
      kind: "installed",
      homeDirectory: homeDir,
      installedConfigPath: getInstalledConfigPath(),
    });
  });

  // --- Linux / systemd tests ---

  it("defaults to systemd on Linux when config + service unit exist", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledSystemdServicePath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledSystemdServicePath(), "[Service]\nExecStart=telepi start\n");

    expect(resolveHandoffMode()).toBe("systemd");
  });

  it("defaults to direct on Linux when no installed service exists", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    process.env.TELEPI_DIR = "/tmp/TelePi";

    expect(resolveHandoffMode()).toBe("direct");
  });

  it("allows explicit systemd mode via env var", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    process.env.TELEPI_HANDOFF_MODE = "systemd";

    expect(resolveHandoffMode()).toBe("systemd");
  });

  it("returns undefined for unknown handoff mode", () => {
    process.env.TELEPI_HANDOFF_MODE = "invalid_mode";

    expect(resolveHandoffMode()).toBeUndefined();
  });

  it("getInstalledSystemdServicePath returns correct path", () => {
    const result = getInstalledSystemdServicePath(homeDir);

    expect(result).toBe(path.join(homeDir, ".config", "systemd", "user", "telepi.service"));
  });

  it("hasInstalledSystemdFlow returns false on macOS", () => {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

    expect(hasInstalledSystemdFlow()).toBe(false);
  });

  it("hasInstalledSystemdFlow returns false on Linux without assets", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });

    expect(hasInstalledSystemdFlow()).toBe(false);
  });

  it("hasInstalledSystemdFlow returns true on Linux with config + service unit", () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    mkdirSync(path.dirname(getInstalledConfigPath()), { recursive: true });
    mkdirSync(path.dirname(getInstalledSystemdServicePath()), { recursive: true });
    writeFileSync(getInstalledConfigPath(), "TELEGRAM_BOT_TOKEN=test\n");
    writeFileSync(getInstalledSystemdServicePath(), "dummy content\n");

    expect(hasInstalledSystemdFlow()).toBe(true);
  });

  it("handoff extension source references systemd mode", () => {
    const source = readFileSync(new URL("../extensions/telepi-handoff.ts", import.meta.url), "utf8");

    expect(source).toContain("systemd");
    expect(source).toContain("handoffViaSystemd");
    expect(source).toContain("systemctl --user set-environment");
    expect(source).toContain("systemctl --user restart telepi.service");
  });
});