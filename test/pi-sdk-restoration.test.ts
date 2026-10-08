import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { vi } from "vitest";
import { PiSessionService } from "../src/pi-session.js";
import { createTelegramUIContext } from "../src/telegram-ui-context.js";
import { createSdkFixture } from "./fixtures/pi-sdk-1-1-0.js";

// Drain SDK refreshes before restoring HOME/network seams, including unregister-on-dispose refreshes.
async function trackService(fixture: ReturnType<typeof createSdkFixture>, service: PiSessionService) {
  const modelRuntime = service.getSession().modelRuntime;
  fixture.track(async () => {
    await service.handback();
    await modelRuntime.refresh({ allowNetwork: false });
  });
  expect(modelRuntime.hasConfiguredAuth("telepi-fixture")).toBe(true);
  expect((await modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`)).toEqual(
    expect.arrayContaining(["telepi-fixture/saved", "telepi-fixture/override"]),
  );
}

async function cleanup(fixture: ReturnType<typeof createSdkFixture>) {
  try {
    expect(fixture.networkSpy).not.toHaveBeenCalled();
  } finally {
    await fixture.cleanup();
  }
  await setTimeout(50);
  expect(existsSync(fixture.root)).toBe(false);
}

const customEntries = (service: PiSessionService) => service.getSession().sessionManager.getEntries()
  .filter((entry) => entry.type === "custom");

describe("Pi 1.1.0 saved-session restoration", () => {
  it("restores saved cwd/settings/model and trusts its project extension headlessly, then awaits handback disposal", async () => {
    const fixture = createSdkFixture();
    const shutdownKey = `telepi-shutdown:${fixture.root}`;
    const globals = globalThis as unknown as Record<string, unknown>;
    try {
      writeFileSync(path.join(fixture.savedWorkspace, ".pi", "extensions", "shutdown.ts"), `
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function extension(pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    const lifecycle = globalThis[${JSON.stringify(shutdownKey)}];
    lifecycle?.started();
    await lifecycle?.gate;
  });
}
`);
      expect(process.env.PI_MODEL).toBeUndefined();
      // A saved selection must beat both the project default and a scope excluding it.
      const settingsPath = path.join(fixture.savedWorkspace, ".pi", "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")),
        defaultModel: "override", enabledModels: ["telepi-fixture/override"],
      }));
      const sessionFile = fixture.persistSession();
      const service = await PiSessionService.create(fixture.config({ piSessionPath: sessionFile }));
      await trackService(fixture, service);
      const session = service.getSession();
      expect(service.getInfo()).toMatchObject({ workspace: fixture.savedWorkspace, model: "telepi-fixture/saved", sessionFile });
      expect(service.getInfo().modelFallbackMessage).toBeUndefined();
      expect(session.sessionManager.getCwd()).toBe(fixture.savedWorkspace);
      expect(session.settingsManager.isProjectTrusted()).toBe(true);
      expect(session.settingsManager.getDefaultModel()).toBe("override");
      expect(session.settingsManager.getEnabledModels()).toEqual(["telepi-fixture/override"]);
      expect(session.settingsManager.getShellPath()).toBe(fixture.shellPath);
      expect(session.settingsManager.getShellCommandPrefix()).toBe("echo fixture-prefix;");
      expect(session.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", content: "Synthetic saved history" })]));
      const commands = await service.listSlashCommands();
      expect(commands).toEqual(expect.arrayContaining([expect.objectContaining({ name: "fixture-workspace", description: "saved" })]));
      expect(service.getInfo().diagnostics?.filter((diagnostic) => diagnostic.type === "error") ?? []).toEqual([]);
      const notify = vi.fn();
      await service.bindExtensions({ uiContext: createTelegramUIContext({ notify }) });
      await service.prompt("/fixture-workspace");
      expect(customEntries(service)).toEqual(expect.arrayContaining([expect.objectContaining({ customType: "fixture-workspace", data: "saved" })]));
      expect(notify).not.toHaveBeenCalled();

      let finishDisposal!: () => void;
      const gate = new Promise<void>((resolve) => { finishDisposal = resolve; });
      // Gate a real project-extension shutdown handler, not the SDK's synchronous dispose API.
      const shutdown = vi.fn();
      globals[shutdownKey] = { gate, started: shutdown };
      const dispose = vi.spyOn(session, "dispose");
      let returned = false;
      const handback = service.handback().then((result) => { returned = true; return result; });
      try {
        await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
        expect(dispose).not.toHaveBeenCalled();
        expect(returned).toBe(false);
      } finally {
        finishDisposal();
        await handback;
      }
      expect(dispose).toHaveBeenCalledOnce();
      expect(await handback).toEqual({ sessionFile, workspace: fixture.savedWorkspace });
      expect(service.hasActiveSession()).toBe(false);
      expect(() => service.getSession()).toThrow("Pi session is not initialized");
      await session.modelRuntime.refresh({ allowNetwork: false });
      const reopened = await PiSessionService.create(fixture.config({ piSessionPath: sessionFile }));
      await trackService(fixture, reopened);
      expect(reopened.getInfo()).toMatchObject({ workspace: fixture.savedWorkspace, model: "telepi-fixture/saved" });
      expect(customEntries(reopened)).toEqual(expect.arrayContaining([expect.objectContaining({ customType: "fixture-workspace", data: "saved" })]));
    } finally {
      try {
        await cleanup(fixture);
      } finally {
        delete globals[shutdownKey];
      }
    }
  });

  it("gives explicit PI_MODEL config precedence over the saved selection", async () => {
    const fixture = createSdkFixture();
    try {
      const settingsPath = path.join(fixture.savedWorkspace, ".pi", "settings.json");
      writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")),
        enabledModels: ["telepi-fixture/saved"],
      }));
      const service = await PiSessionService.create(fixture.config({
        piSessionPath: fixture.persistSession(), piModel: "telepi-fixture/override",
      }));
      await trackService(fixture, service);
      expect(service.getInfo()).toMatchObject({ workspace: fixture.savedWorkspace, model: "telepi-fixture/override" });
      expect(service.getInfo().modelFallbackMessage).toBeUndefined();
    } finally {
      await cleanup(fixture);
    }
  });

  it("visibly reports unavailable saved-model fallback to an available replacement", async () => {
    const fixture = createSdkFixture();
    try {
      const service = await PiSessionService.create(fixture.config({ piSessionPath: fixture.persistSession("unavailable") }));
      await trackService(fixture, service);
      const info = service.getInfo();
      expect(info.workspace).toBe(fixture.savedWorkspace);
      expect(info.model).toBe("telepi-fixture/saved");
      expect(info.modelFallbackMessage).toContain("telepi-fixture/unavailable");
      expect(info.modelFallbackMessage).toContain("Using telepi-fixture/saved");
    } finally {
      await cleanup(fixture);
    }
  });
});
