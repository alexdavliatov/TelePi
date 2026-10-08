import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import type { Update } from "grammy/types";
import { vi } from "vitest";
import { createBot } from "../src/bot.js";
import { PiSessionRegistry } from "../src/pi-session.js";
import { createSdkFixture } from "./fixtures/pi-sdk-1-1-0.js";

type ApiCall = { method: string; payload: Record<string, any>; messageId?: number };
const target = { chatId: 456 };
const from = { id: 123, is_bot: false, first_name: "Synthetic" };
const chat = { id: target.chatId, type: "private" as const };

async function setup() {
  const fixture = createSdkFixture();
  try {
    const config = fixture.config();
    const registry = await PiSessionRegistry.create(config);
    const service = await registry.getOrCreate(target);
    const session = service.getSession();
    fixture.track(async () => {
      await service.handback();
      await session.modelRuntime.refresh({ allowNetwork: false });
      registry.dispose();
    });
    const bind = vi.spyOn(session, "bindExtensions");
    const prompt = vi.spyOn(session, "prompt");
    const stream = vi.spyOn(session.modelRuntime, "streamSimple");
    const bot = createBot(config, registry);
    bot.botInfo = { id: 1, is_bot: true, first_name: "Synthetic TelePi", username: "telepi_fixture_bot",
      can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
    const calls: ApiCall[] = [];
    let messageId = 100;
    let updateId = 0;
    bot.api.config.use(async (_prev, method, payload) => {
      const call: ApiCall = { method, payload };
      calls.push(call);
      if (method === "sendMessage") {
        call.messageId = ++messageId;
        return { ok: true, result: { message_id: messageId, date: 1, chat, text: payload.text } } as any;
      }
      if (["editMessageText", "editMessageReplyMarkup", "answerCallbackQuery", "sendChatAction", "setMyCommands"].includes(method)) {
        return { ok: true, result: true } as any;
      }
      throw new Error(`Unexpected synthetic Telegram method: ${method}`);
    });
    const entries = () => session.sessionManager.getEntries().filter((entry) => entry.type === "custom");
    const message = async (text: string) => bot.handleUpdate({ update_id: ++updateId, message: {
      message_id: ++messageId, date: 1, chat, from, text,
      ...(text.startsWith("/") ? { entities: [{ offset: 0, length: text.split(/\s/)[0]!.length, type: "bot_command" }] } : {}),
    } } as Update);
    const callback = async (call: ApiCall, data: string) => bot.handleUpdate({ update_id: ++updateId, callback_query: {
      id: `synthetic-${updateId}`, chat_instance: "synthetic", from, data,
      message: { message_id: call.messageId!, date: 1, chat },
    } } as Update);
    const waitUntil = async (predicate: () => boolean) => {
      for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await setTimeout(10);
      expect(predicate(), "synthetic handler did not reach the expected continuation").toBe(true);
    };
    const dialog = async (prefix: string, after = 0) => {
      const find = () => calls.slice(after).find((call) => call.method === "sendMessage" &&
        call.payload.reply_markup?.inline_keyboard?.flat().some((button: any) => button.callback_data?.startsWith(prefix)));
      await waitUntil(() => Boolean(find()));
      // The transport sends before registering pending state; give the promise continuation a turn.
      await setTimeout(0);
      return find()!;
    };
    const button = (call: ApiCall, suffix: string) => {
      const match = call.payload.reply_markup.inline_keyboard.flat().find((item: any) => item.callback_data.endsWith(suffix));
      expect(match).toBeDefined();
      return match.callback_data as string;
    };
    const complete = async () => {
      await waitUntil(() => entries().some((entry) => entry.customType === "fixture-complete"));
      await message("/fixture-workspace");
      await waitUntil(() => entries().some((entry) => entry.customType === "fixture-workspace"));
    };
    return { fixture, service, session, bind, prompt, stream, calls, entries, message, callback, dialog, button, complete, waitUntil,
      async cleanup() {
        try {
          vi.useRealTimers();
          await message("/abort");
          await setTimeout(20);
          expect(stream).not.toHaveBeenCalled();
          expect(fixture.networkSpy).not.toHaveBeenCalled();
        } finally {
          await fixture.cleanup();
          await setTimeout(50);
          expect(existsSync(fixture.root)).toBe(false);
        }
      },
    };
  } catch (error) {
    await fixture.cleanup();
    throw error;
  }
}

describe("Pi 1.1.0 real SDK Telegram questions", () => {
  it("binds the Telegram adapter and resumes select/confirm/input with exact answers", async () => {
    const test = await setup();
    try {
      expect(await test.service.listSlashCommands()).toEqual(expect.arrayContaining([expect.objectContaining({ name: test.fixture.dialogs.command })]));
      await test.message(`/${test.fixture.dialogs.command}`);
      const select = await test.dialog("ui_sel_");
      expect(test.bind).toHaveBeenCalledWith(expect.objectContaining({ uiContext: expect.objectContaining({ select: expect.any(Function), confirm: expect.any(Function), input: expect.any(Function) }) }));
      expect(test.entries()).toEqual([]);
      const beta = test.button(select, "_1");
      const beforeAnswer = test.calls.length;
      await test.callback(select, beta);
      const answerCalls = test.calls.slice(beforeAnswer);
      expect(answerCalls.findIndex((call) => call.method === "answerCallbackQuery")).toBeLessThan(
        answerCalls.findIndex((call) => call.method === "editMessageText"),
      );
      expect(test.entries()).toEqual([expect.objectContaining({ customType: "fixture-select", data: "Beta" })]);
      // A repeated/stale callback must not continue a second time or resolve the next dialog.
      await test.callback(select, beta);
      const confirm = await test.dialog("ui_cfm_");
      expect(test.entries()).toHaveLength(1);
      await test.callback(confirm, test.button(confirm, "_yes"));
      await test.dialog("ui_x_", test.calls.indexOf(confirm) + 1);
      expect(test.entries()).toEqual([
        expect.objectContaining({ customType: "fixture-select", data: "Beta" }),
        expect.objectContaining({ customType: "fixture-confirm", data: true }),
      ]);
      await test.message("synthetic answer");
      await test.complete();
      expect(test.entries().slice(0, 4)).toEqual([
        expect.objectContaining({ customType: "fixture-select", data: "Beta" }),
        expect.objectContaining({ customType: "fixture-confirm", data: true }),
        expect.objectContaining({ customType: "fixture-input", data: "synthetic answer" }),
        expect.objectContaining({ customType: "fixture-complete", data: true }),
      ]);
      expect(test.prompt.mock.calls.map(([text]) => text)).toEqual(["/fixture-dialog", "/fixture-workspace"]);
    } finally {
      await test.cleanup();
    }
  });

  it.each(["select", "confirm", "input"] as const)("resumes %s cancellation via /abort", async (kind) => {
    const test = await setup();
    try {
      await test.message(`/${test.fixture.dialogs.cancellable[kind]}`);
      await test.dialog(kind === "select" ? "ui_sel_" : kind === "confirm" ? "ui_cfm_" : "ui_x_");
      expect(test.entries()).toEqual([]);
      await test.message("/abort");
      await test.complete();
      expect(test.entries()[0]).toMatchObject({ customType: `fixture-${kind}` });
      expect(test.entries()[0]!.data).toBe(kind === "confirm" ? false : undefined);
    } finally {
      await test.cleanup();
    }
  });

  it.each(["select", "input"] as const)("resumes %s cancel button and ignores its stale callback", async (kind) => {
    const test = await setup();
    try {
      await test.message(`/${test.fixture.dialogs.cancellable[kind]}`);
      const dialog = await test.dialog("ui_x_");
      const cancel = dialog.payload.reply_markup.inline_keyboard.flat().find((item: any) => item.callback_data.startsWith("ui_x_")).callback_data;
      await test.callback(dialog, cancel);
      await test.complete();
      const count = test.entries().length;
      await test.callback(dialog, cancel);
      expect(test.entries()).toHaveLength(count);
      expect(test.entries()[0]!.data).toBeUndefined();
    } finally {
      await test.cleanup();
    }
  });

  it.each(["select", "confirm", "input"] as const)("resumes %s AbortSignal and removes its listener", async (kind) => {
    const test = await setup();
    const add = vi.spyOn(AbortSignal.prototype, "addEventListener");
    const remove = vi.spyOn(AbortSignal.prototype, "removeEventListener");
    try {
      await test.message(`/${test.fixture.dialogs.cancellable[kind]}`);
      await test.dialog(kind === "select" ? "ui_sel_" : kind === "confirm" ? "ui_cfm_" : "ui_x_");
      const registration = add.mock.calls.findIndex(([event]) => event === "abort");
      expect(registration).toBeGreaterThanOrEqual(0);
      const listener = add.mock.calls[registration]![1];
      const signal = add.mock.contexts[registration];
      await test.session.prompt(`/${test.fixture.dialogs.abortSignal}`);
      await test.complete();
      expect(test.entries()[0]!.data).toBe(kind === "confirm" ? false : undefined);
      expect(remove.mock.calls.some(([event, candidate], index) => event === "abort" && candidate === listener && remove.mock.contexts[index] === signal)).toBe(true);
    } finally {
      add.mockRestore();
      remove.mockRestore();
      await test.cleanup();
    }
  });

  it("times out a pending SDK input with controlled timers and clears the dialog timer", async () => {
    const test = await setup();
    try {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await test.message(`/${test.fixture.dialogs.cancellable.input} ${test.fixture.dialogs.timeoutArgs}`);
      await test.dialog("ui_x_");
      expect(test.entries()).toEqual([]);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
      await test.complete();
      expect(test.entries()[0]!.data).toBeUndefined();
    } finally {
      await test.cleanup();
    }
  });
});
