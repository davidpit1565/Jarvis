import { describe, test, expect } from "bun:test";
import { WatcherNotifier } from "@/watcher/WatcherNotifier";
import { emptyWatcherChannelConfig } from "@/watcher/WatcherChannelRouter";
import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import type { ProactiveAnnouncer } from "@/communication/voice/ProactiveAnnouncer";

function stubTelegram(): { gateway: TelegramGateway; sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  const gateway = {
    sendMessage: async (chatId: string, text: string) => {
      sent.push({ chatId, text });
    },
  } as unknown as TelegramGateway;
  return { gateway, sent };
}

function stubAnnouncer(): { announcer: ProactiveAnnouncer; announced: Array<{ deviceId: string; text: string }> } {
  const announced: Array<{ deviceId: string; text: string }> = [];
  const announcer = {
    announce: async (deviceId: string, text: string) => {
      announced.push({ deviceId, text });
      return { responded: false, authenticated: false, replyText: null };
    },
  } as unknown as ProactiveAnnouncer;
  return { announcer, announced };
}

describe("WatcherNotifier", () => {
  test("default routing sends via telegram", async () => {
    const { gateway, sent } = stubTelegram();
    const notifier = new WatcherNotifier(gateway, "chat1");

    const result = await notifier.notify("news:x", "hello", emptyWatcherChannelConfig());

    expect(result).toEqual({ channel: "telegram", delivered: true });
    expect(sent).toEqual([{ chatId: "chat1", text: "hello" }]);
  });

  test("an explicitly high-priority source with a configured device announces instead of texting", async () => {
    const { gateway, sent } = stubTelegram();
    const { announcer, announced } = stubAnnouncer();
    const notifier = new WatcherNotifier(gateway, "chat1", announcer, "device1");
    const config = { ...emptyWatcherChannelConfig(), highPrioritySourceIds: new Set(["news:urgent"]) };

    const result = await notifier.notify("news:urgent", "urgent thing", config);

    expect(result.channel).toBe("device-announce");
    expect(result.delivered).toBe(true);
    expect(announced).toEqual([{ deviceId: "device1", text: "urgent thing" }]);
    expect(sent).toEqual([]);
  });

  test("a high-priority source falls back to telegram when no device/announcer is configured, rather than dropping the notification", async () => {
    const { gateway, sent } = stubTelegram();
    const notifier = new WatcherNotifier(gateway, "chat1");
    const config = { ...emptyWatcherChannelConfig(), highPrioritySourceIds: new Set(["news:urgent"]) };

    const result = await notifier.notify("news:urgent", "urgent thing", config);

    expect(result.channel).toBe("telegram");
    expect(result.delivered).toBe(true);
    expect(result.note).toContain("fell back to telegram");
    expect(sent).toEqual([{ chatId: "chat1", text: "urgent thing" }]);
  });

  test("the phone channel is a deliberate no-op stub — never attempts a real call", async () => {
    const { gateway, sent } = stubTelegram();
    const notifier = new WatcherNotifier(gateway, "chat1");
    const config = { ...emptyWatcherChannelConfig(), phoneSourceIds: new Set(["github:owner/repo"]) };

    const result = await notifier.notify("github:owner/repo", "something", config);

    expect(result).toEqual({ channel: "phone", delivered: false, note: expect.stringContaining("not available yet") });
    expect(sent).toEqual([]);
  });

  test("reports non-delivery honestly when telegram itself isn't configured", async () => {
    const notifier = new WatcherNotifier(undefined, undefined);
    const result = await notifier.notify("news:x", "hello", emptyWatcherChannelConfig());
    expect(result.delivered).toBe(false);
    expect(result.channel).toBe("telegram");
  });
});
