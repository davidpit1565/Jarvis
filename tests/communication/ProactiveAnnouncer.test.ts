import { describe, test, expect } from "bun:test";
import { ProactiveAnnouncer } from "@/communication/voice/ProactiveAnnouncer";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { SpeakerAuthenticator } from "@/core/confirmation/SpeakerAuthenticator";

function stubDeviceConnectionManager(sendImpl?: (deviceId: string, raw: string) => void): {
  manager: DeviceConnectionManager;
  sent: Array<{ deviceId: string; payload: { text: string; announcementId: string; replyWindowMs: number } }>;
} {
  const sent: Array<{ deviceId: string; payload: { text: string; announcementId: string; replyWindowMs: number } }> = [];
  const manager = {
    send: (deviceId: string, raw: string) => {
      if (sendImpl) {
        sendImpl(deviceId, raw);
        return;
      }
      const envelope = JSON.parse(raw) as { deviceId: string; payload: { text: string; announcementId: string; replyWindowMs: number } };
      sent.push({ deviceId, payload: envelope.payload });
    },
  } as unknown as DeviceConnectionManager;
  return { manager, sent };
}

function alwaysAuthenticator(authenticated: boolean): SpeakerAuthenticator {
  return { authenticate: () => ({ authenticated, reason: "test" }) };
}

describe("ProactiveAnnouncer", () => {
  test("resolves authenticated=true when the authenticator accepts the reply", async () => {
    const { manager, sent } = stubDeviceConnectionManager();
    const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(true));

    const resultPromise = announcer.announce("mac-1", "You have a reminder.", 5_000);
    const { announcementId } = sent[0]!.payload;
    announcer.handleReply("mac-1", { announcementId, text: "open sesame" });

    const result = await resultPromise;
    expect(result).toEqual({ responded: true, authenticated: true, replyText: "open sesame" });
  });

  test("resolves authenticated=false when the authenticator rejects the reply", async () => {
    const { manager, sent } = stubDeviceConnectionManager();
    const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(false));

    const resultPromise = announcer.announce("mac-1", "You have a reminder.", 5_000);
    const { announcementId } = sent[0]!.payload;
    announcer.handleReply("mac-1", { announcementId, text: "wrong words" });

    const result = await resultPromise;
    expect(result).toEqual({ responded: true, authenticated: false, replyText: "wrong words" });
  });

  test("resolves responded=false when the device reports nothing was heard", async () => {
    const { manager, sent } = stubDeviceConnectionManager();
    const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(true));

    const resultPromise = announcer.announce("mac-1", "You have a reminder.", 5_000);
    const { announcementId } = sent[0]!.payload;
    announcer.handleReply("mac-1", { announcementId, text: null });

    const result = await resultPromise;
    expect(result).toEqual({ responded: false, authenticated: false, replyText: null });
  });

  test(
    "times out to responded=false when no proactive.reply ever arrives",
    async () => {
      const { manager } = stubDeviceConnectionManager();
      const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(true));

      // ProactiveAnnouncer waits replyWindowMs plus a fixed network grace
      // period beyond it (see its own REPLY_GRACE_MS) before giving up, so
      // this test needs a longer-than-default timeout to actually observe
      // that timeout firing rather than racing it.
      const result = await announcer.announce("mac-1", "You have a reminder.", 10);
      expect(result).toEqual({ responded: false, authenticated: false, replyText: null });
    },
    10_000
  );

  test("resolves responded=false (never throws) when the send itself fails", async () => {
    const { manager } = stubDeviceConnectionManager(() => {
      throw new Error("device disconnected");
    });
    const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(true));

    const result = await announcer.announce("mac-1", "You have a reminder.", 5_000);
    expect(result).toEqual({ responded: false, authenticated: false, replyText: null });
  });

  test(
    "ignores a reply for an unknown/stale announcementId",
    async () => {
      const { manager, sent } = stubDeviceConnectionManager();
      const announcer = new ProactiveAnnouncer(manager, alwaysAuthenticator(true));

      const resultPromise = announcer.announce("mac-1", "You have a reminder.", 20);
      announcer.handleReply("mac-1", { announcementId: "not-a-real-id", text: "hello" });
      void sent;

      // The stale reply must not resolve this promise — it should still time out normally.
      const result = await resultPromise;
      expect(result.responded).toBe(false);
    },
    10_000
  );
});
