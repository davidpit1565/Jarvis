import { describe, test, expect } from "bun:test";
import { DeviceVoiceGateway, type DeviceVoiceSession } from "@/communication/voice/DeviceVoiceGateway";
import type { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

function makeStubOrchestrator(handle: (userId: string, message: string) => Promise<string>): Orchestrator {
  return { handleUserMessage: handle } as unknown as Orchestrator;
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
});
