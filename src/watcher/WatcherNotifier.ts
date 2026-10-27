import type { TelegramGateway } from "@/communication/telegram/TelegramGateway";
import type { ProactiveAnnouncer } from "@/communication/voice/ProactiveAnnouncer";
import { routeWatcherSource, type WatcherChannelConfig } from "@/watcher/WatcherChannelRouter";

export interface WatcherNotifyResult {
  channel: "telegram" | "device-announce" | "phone";
  delivered: boolean;
  /** Set when delivery didn't happen as routed (e.g. device-announce requested but no device configured — falls back to Telegram) or for the phone stub. */
  note?: string;
}

/**
 * Actually sends a watcher notification out on whichever channel
 * `routeWatcherSource` picks — the genuinely-new capability CLAUDE.md's
 * spec calls for ("actual proactive *notification*, not just 'mentioned
 * next time you talk to it'"). This is distinct from, and in addition to,
 * `githubActivityNote`/`composeWatcherNote` surfacing the same cached
 * activity at the *start of the next conversation* — both can fire for the
 * same event; see the introducing PR description for why that's an honest
 * (if slightly redundant) tradeoff rather than a gap being papered over.
 *
 * Channel honesty, per CLAUDE.md:
 * - "telegram" (the default for everything): sends via the existing
 *   `TelegramGateway`, same mechanism `NOTIFY_USER`/reminders already use.
 * - "device-announce": only when a source is explicitly configured
 *   high-priority AND a target device is actually configured — if either
 *   is missing, this falls back to Telegram rather than silently dropping
 *   the notification, because a watcher finding something new is exactly
 *   the kind of thing that must never go unreported just because the
 *   louder channel isn't wired up yet.
 * - "phone": a deliberate no-op stub. David has not connected a phone
 *   number for Twilio (see CLAUDE.md), so this channel is inert by
 *   design today — it reports `delivered: false` with an explanatory
 *   note rather than attempting (and failing) a real call, or silently
 *   falling back to another channel and hiding that phone routing was
 *   requested at all.
 */
export class WatcherNotifier {
  constructor(
    private readonly telegramGateway: TelegramGateway | undefined,
    private readonly ownerChatId: string | undefined,
    private readonly proactiveAnnouncer?: ProactiveAnnouncer,
    private readonly announceDeviceId?: string,
    private readonly announceReplyWindowMs: number = 15_000
  ) {}

  async notify(sourceId: string, text: string, config: WatcherChannelConfig): Promise<WatcherNotifyResult> {
    const decision = routeWatcherSource(sourceId, config);

    if (decision.channel === "phone") {
      return { channel: "phone", delivered: false, note: "phone channel not available yet (no number connected) — stub only, per CLAUDE.md" };
    }

    if (decision.channel === "device-announce") {
      if (this.proactiveAnnouncer && this.announceDeviceId) {
        await this.proactiveAnnouncer.announce(this.announceDeviceId, text, this.announceReplyWindowMs);
        return { channel: "device-announce", delivered: true };
      }
      // Falls through to Telegram below rather than dropping the
      // notification — see class doc comment.
      const fallback = await this.sendTelegram(text);
      return { ...fallback, note: "device-announce requested but no announcer/device configured — fell back to telegram" };
    }

    return this.sendTelegram(text);
  }

  private async sendTelegram(text: string): Promise<WatcherNotifyResult> {
    if (!this.telegramGateway || !this.ownerChatId) {
      return { channel: "telegram", delivered: false, note: "telegram not configured (missing gateway/owner chat id)" };
    }
    await this.telegramGateway.sendMessage(this.ownerChatId, text);
    return { channel: "telegram", delivered: true };
  }
}
