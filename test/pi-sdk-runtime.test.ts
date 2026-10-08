import { existsSync, rmSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createSdkFixture } from "./fixtures/pi-sdk-1-1-0.js";

const recording = vi.hoisted(() => ({
  factories: [] as Array<{ cwd: string; options: any; definition: any; original: any }>,
  executions: [] as Array<{ command: string; cwd: string; options: any }>,
  delegates: [] as any[][],
}));

// ESM namespace properties cannot safely be spied on. All session/services APIs stay real.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...actual,
    createBashToolDefinition: (cwd: string, options: any) => {
      const original = actual.createBashToolDefinition(cwd, { ...options, operations: {
        exec: async (command: string, executionCwd: string, executionOptions: any) => {
          recording.executions.push({ command, cwd: executionCwd, options: executionOptions });
          executionOptions.onData(Buffer.from("safe recording output\n"));
          return { exitCode: 0 };
        },
      } });
      const definition = { ...original, execute: (...args: Parameters<typeof original.execute>) => {
        recording.delegates.push(args);
        return original.execute(...args);
      } };
      recording.factories.push({ cwd, options, definition, original });
      return definition;
    },
  };
});

import { createPiSession, PiSessionService } from "../src/pi-session.js";

const blockedCommands = [
  "launchctl kickstart -k gui/$UID/com.telepi",
  "echo ready & launchctl kickstart -k gui/$UID/com.telepi",
  "sudo -E launchctl kickstart -k gui/$UID/com.telepi",
  "(launchctl kickstart -k gui/$UID/com.telepi)",
  'bash -c "launchctl kickstart -k gui/$UID/com.telepi"',
];

async function cleanupAndAssertRemoved(fixture: ReturnType<typeof createSdkFixture>) {
  try {
    await fixture.cleanup();
  } finally {
    try {
      // Let background SDK work settle before checking that teardown stays complete.
      await setTimeout(50);
      expect(existsSync(fixture.root)).toBe(false);
    } finally {
      // Also remove a recreated root when cleanup or the regression assertion fails.
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
}

describe("Pi 1.1.0 real runtime", () => {
  beforeEach(() => {
    recording.factories.length = 0;
    recording.executions.length = 0;
    recording.delegates.length = 0;
  });

  it("retains guarded custom bash across activation, binding, reload and prompt loadout preparation", async () => {
    const fixture = createSdkFixture();
    try {
      // This regression targets tool loadouts, not implicit initial model selection (Task 2).
      const handle = await createPiSession(fixture.config({ piModel: "telepi-fixture/override" }));
      fixture.track(async () => {
        try {
          await handle.dispose();
        } finally {
          // SDK disposal does not await refreshes started by reload/provider cleanup.
          await handle.runtime.services.modelRuntime.refresh({ allowNetwork: false });
        }
      });
      const { session, services } = handle.runtime;
      expect(services.agentDir).toBe(fixture.agentDir);
      expect(services.settingsManager.getShellPath()).toBe(fixture.shellPath);
      expect((await services.modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`)).toEqual(
        expect.arrayContaining(["telepi-fixture/saved", "telepi-fixture/override"]),
      );
      expect(session.model?.provider).toBe("telepi-fixture");
      expect(session.getActiveToolNames()).toContain("fixture-tool");
      expect(recording.factories).toHaveLength(1);
      const factory = recording.factories[0]!;
      expect(factory.options).toEqual({ shellPath: fixture.shellPath, commandPrefix: "echo fixture-prefix;" });
      expect(factory.original.outputSchema).toBeDefined();
      const updates: any[] = [];
      session.subscribe((event) => { if (event.type === "tool_execution_update") updates.push(event); });

      const refreshes = [
        async () => {},
        async () => session.setActiveToolsByName(session.getActiveToolNames()),
        async () => session.bindExtensions({}),
        async () => session.reload(),
      ];
      for (const refresh of refreshes) {
        await refresh();
        expect(services.settingsManager.getShellPath()).toBe(fixture.shellPath);
        expect(session.getActiveToolNames()).toContain("fixture-tool");
        const guarded = session.getToolDefinition("bash")!;
        expect(guarded.description).toContain("Commands time out after 120 seconds by default.");
        for (const key of ["parameters", "outputSchema", "promptSnippet", "promptGuidelines", "renderCall", "renderResult"] as const) {
          expect(guarded[key]).toBe(factory.original[key]);
        }
        fixture.setResponses([
          fauxAssistantMessage([
            fauxToolCall("bash", { command: "echo safe-default" }),
            fauxToolCall("bash", { command: "echo safe-explicit", timeout: 9 }),
            ...blockedCommands.map((command) => fauxToolCall("bash", { command })),
            fauxToolCall("fixture-tool", {}),
          ], { stopReason: "toolUse" }),
          fauxAssistantMessage("done"),
        ]);
        const count = recording.executions.length;
        const delegateCount = recording.delegates.length;
        const providerCalls = fixture.faux.state.callCount;
        await session.prompt("Exercise synthetic guarded tools");
        expect(fixture.faux.state.callCount - providerCalls).toBe(2);
        expect(recording.executions.slice(count).map((call) => call.options.timeout)).toEqual([120, 9]);
        expect(recording.executions.slice(count).map((call) => call.command)).toEqual([
          "echo fixture-prefix;\necho safe-default", "echo fixture-prefix;\necho safe-explicit",
        ]);
        expect(recording.executions.slice(count).every((call) => call.cwd === fixture.workspace)).toBe(true);
        const results = session.messages.filter((message) => message.role === "toolResult").slice(-8);
        expect(results).toHaveLength(8);
        expect(JSON.stringify(results[0])).toContain("safe recording output");
        for (const result of results.slice(2, 7)) {
          expect(result).toMatchObject({ isError: true });
          expect(JSON.stringify(result)).toContain("Blocked TelePi self-management command");
        }
        expect(JSON.stringify(results[7])).toContain("fixture-tool-result");
        expect(fixture.shellInvocations()).toEqual([]);
        // Context getters deliberately become stale after reload; inspect them before the next refresh.
        for (const args of recording.delegates.slice(delegateCount)) {
          expect(args).toHaveLength(5);
          expect(args[2]).toBeInstanceOf(AbortSignal);
          expect(args[3]).toBeTypeOf("function");
          expect(args[4]).toMatchObject({ cwd: fixture.workspace });
          const execution = recording.executions.find((call) => call.options.signal === args[2]);
          expect(execution).toBeDefined();
        }
      }
      expect(updates.length).toBeGreaterThan(0);
      expect(fixture.fetchSpy).not.toHaveBeenCalled();
      expect(fixture.networkSpy).not.toHaveBeenCalled();
    } finally {
      await cleanupAndAssertRemoved(fixture);
    }
  });

  it("persists synthetic history with the requested fixture model attribution", async () => {
    const fixture = createSdkFixture();
    try {
      const file = fixture.persistSession("saved");
      const manager = SessionManager.open(file);
      expect(manager.getCwd()).toBe(fixture.savedWorkspace);
      expect(manager.buildSessionContext().model).toEqual({ provider: "telepi-fixture", modelId: "saved" });
      expect(manager.buildSessionContext().messages).toHaveLength(2);
    } finally {
      await fixture.cleanup();
    }
  });

  it("refreshes the real SDK context projection after awaited cross-workspace setup", async () => {
    const fixture = createSdkFixture();
    try {
      const service = await PiSessionService.create(fixture.config());
      fixture.track(() => service.handback());
      const initial = service.getSession();
      const prototype = Object.getPrototypeOf(initial);
      const refresh = vi.spyOn(prototype, "refreshContext");
      try {
        let setupFinished = false;
        const before = refresh.mock.calls.length;
        await service.newSession({ workspace: fixture.savedWorkspace, setup: async (manager) => {
          await Promise.resolve();
          expect(refresh.mock.calls.length).toBe(before);
          manager.appendMessage({ role: "user", content: "Awaited synthetic setup", timestamp: 1 });
          manager.appendMessage(fauxAssistantMessage("Setup answer"));
          setupFinished = true;
        } });
        expect(setupFinished).toBe(true);
        expect(refresh.mock.calls.length - before).toBe(1);
        const session = service.getSession();
        expect(session).not.toBe(initial);
        expect(session.messages).toEqual(session.sessionManager.buildSessionContext().messages);
        expect(JSON.stringify(session.messages)).toContain("Awaited synthetic setup");
        expect(session.sessionManager.buildSessionProjection().messages).toEqual(session.messages);
        expect(fixture.fetchSpy).not.toHaveBeenCalled();
        expect(fixture.networkSpy).not.toHaveBeenCalled();
      } finally {
        refresh.mockRestore();
      }
    } finally {
      await cleanupAndAssertRemoved(fixture);
    }
  });
});
