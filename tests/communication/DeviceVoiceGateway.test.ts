import { describe, test, expect } from "bun:test";
import { DeviceVoiceGateway, type DeviceVoiceSession } from "@/communication/voice/DeviceVoiceGateway";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

function makeStubOrchestrator(handle: (userId: string, message: string) => Promise<string>): Orchestrator {
  return { handleUserMessage: handle } as unknown as Orchestrator;
}

/** Captures exactly what text reached the orchestrator, to assert on any language directive prepended to it. */
function makeCapturingOrchestrator(): { orchestrator: Orchestrator; receivedMessages: string[] } {
  const receivedMessages: string[] = [];
  const orchestrator = makeStubOrchestrator(async (_userId, message) => {
    receivedMessages.push(message);
    return "ok";
  });
  return { orchestrator, receivedMessages };
}

function stubDeviceConnectionManager(): {
  manager: DeviceConnectionManager;
  calls: Array<{ deviceId: string; text: string }>;
} {
  const calls: Array<{ deviceId: string; text: string }> = [];
  const manager = {
    send: (deviceId: string, raw: string) => {
      const envelope = JSON.parse(raw) as { deviceId: string; payload: { text: string } };
      calls.push({ deviceId, text: envelope.payload.text });
    },
  } as unknown as DeviceConnectionManager;
  return { manager, calls };
}

describe("DeviceVoiceGateway.handleTranscript", () => {
  test("routes a transcript through the device's orchestrator and speaks the reply back", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const gateway = new DeviceVoiceGateway(manager, () => ({
      orchestrator: makeStubOrchestrator(async () => "You have three meetings today."),
      userId: "local-user",
    }));

    await gateway.handleTranscript("mac-1", "what's on my calendar");

    expect(calls).toEqual([{ deviceId: "mac-1", text: "You have three meetings today." }]);
  });

  test("reuses the same session (conversation) across multiple transcripts from the same device", async () => {
    const { manager } = stubDeviceConnectionManager();
    let sessionCreations = 0;
    const gateway = new DeviceVoiceGateway(manager, () => {
      sessionCreations += 1;
      return { orchestrator: makeStubOrchestrator(async () => "ok"), userId: "local-user" };
    });

    await gateway.handleTranscript("mac-1", "first");
    await gateway.handleTranscript("mac-1", "second");

    expect(sessionCreations).toBe(1);
  });

  test("sends a spoken-style error reply if the orchestrator throws, without throwing itself", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const gateway = new DeviceVoiceGateway(manager, () => ({
      orchestrator: makeStubOrchestrator(async () => {
        throw new Error("brain exploded");
      }),
      userId: "local-user",
    }));

    await expect(gateway.handleTranscript("mac-1", "do something")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text).toMatch(/something went wrong/i);
  });

  test("forces an English reply directive when the wake phrase was the English one", async () => {
    const { manager } = stubDeviceConnectionManager();
    const { orchestrator, receivedMessages } = makeCapturingOrchestrator();
    const gateway = new DeviceVoiceGateway(manager, () => ({ orchestrator, userId: "local-user" }));

    await gateway.handleTranscript("mac-1", "מה השעה", "en");

    expect(receivedMessages[0]).toMatch(/^\[Reply in English/);
    expect(receivedMessages[0]).toContain("מה השעה");
  });

  test("forces a Hebrew reply directive when the wake phrase was Jarvis Shomea", async () => {
    const { manager } = stubDeviceConnectionManager();
    const { orchestrator, receivedMessages } = makeCapturingOrchestrator();
    const gateway = new DeviceVoiceGateway(manager, () => ({ orchestrator, userId: "local-user" }));

    await gateway.handleTranscript("mac-1", "what's the weather", "he");

    expect(receivedMessages[0]).toMatch(/^\[ענה בעברית/);
    expect(receivedMessages[0]).toContain("what's the weather");
  });

  test("applies no language directive when no forced language is given (e.g. a clap-triggered command)", async () => {
    const { manager } = stubDeviceConnectionManager();
    const { orchestrator, receivedMessages } = makeCapturingOrchestrator();
    const gateway = new DeviceVoiceGateway(manager, () => ({ orchestrator, userId: "local-user" }));

    await gateway.handleTranscript("mac-1", "what's on my calendar");

    expect(receivedMessages[0]).toBe("what's on my calendar");
  });
});

describe("DeviceVoiceGateway.awaitConfirmation", () => {
  function makeSession(): DeviceVoiceSession {
    return { orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" };
  }

  test("resolves true when the device transcribes yes", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const gateway = new DeviceVoiceGateway(manager, makeSession);

    const resultPromise = gateway.awaitConfirmation("mac-1", "Run the dangerous tool?");
    await gateway.handleTranscript("mac-1", "yes");

    expect(await resultPromise).toBe(true);
    expect(calls[calls.length - 1]).toEqual({ deviceId: "mac-1", text: "Confirmed." });
  });

  test("resolves false when the device transcribes no", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const gateway = new DeviceVoiceGateway(manager, makeSession);

    const resultPromise = gateway.awaitConfirmation("mac-1", "Run the dangerous tool?");
    await gateway.handleTranscript("mac-1", "no");

    expect(await resultPromise).toBe(false);
    expect(calls[calls.length - 1]).toEqual({ deviceId: "mac-1", text: "Cancelled." });
  });

  test("re-prompts on an unrecognized answer without resolving", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const gateway = new DeviceVoiceGateway(manager, makeSession);

    void gateway.awaitConfirmation("mac-1", "Run the dangerous tool?");
    await gateway.handleTranscript("mac-1", "maybe later");

    expect(calls[calls.length - 1]).toEqual({ deviceId: "mac-1", text: "Please say yes or no." });
  });

  test("an unanswered confirmation times out to false and clears the pending entry, instead of bricking the device", async () => {
    const { manager, calls } = stubDeviceConnectionManager();
    const { orchestrator, receivedMessages } = makeCapturingOrchestrator();
    const gateway = new DeviceVoiceGateway(manager, () => ({ orchestrator, userId: "local-user" }));

    const resultPromise = gateway.awaitConfirmation("mac-1", "Run the dangerous tool?", 10);
    expect(await resultPromise).toBe(false);

    // A normal transcript sent afterward must reach the orchestrator like
    // any other — not get treated as a stale yes/no answer.
    await gateway.handleTranscript("mac-1", "what's on my calendar");

    expect(receivedMessages).toContain("what's on my calendar");
    expect(calls.some((c) => c.text === "Please say yes or no.")).toBe(false);
  });
});
