import { describe, test, expect } from "bun:test";
import { TwilioVoiceGateway, type PhoneSession } from "@/communication/phone/TwilioVoiceGateway";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

function makeStubOrchestrator(handle: (userId: string, message: string) => Promise<string>): Orchestrator {
  return { handleUserMessage: handle } as unknown as Orchestrator;
}

describe("TwilioVoiceGateway", () => {
  test("handleIncomingCall greets the caller and starts gathering speech", () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const response = gateway.handleIncomingCall("CA1");
    expect(response.headers.get("Content-Type")).toBe("text/xml");
  });

  test("uses a natural neural voice by default", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();
    expect(body).toContain('voice="Polly.Matthew-Neural"');
  });

  test("honors a custom voice passed to the constructor", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      "Google.en-US-Chirp3-HD-Charon"
    );

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();
    expect(body).toContain('voice="Google.en-US-Chirp3-HD-Charon"');
  });

  test("a call's session is created once and reused across gather turns", async () => {
    let sessionsCreated = 0;
    const gateway = new TwilioVoiceGateway((): PhoneSession => {
      sessionsCreated++;
      return { orchestrator: makeStubOrchestrator(async () => "ok"), userId: "local-user" };
    });

    gateway.handleIncomingCall("CA1");
    await gateway.handleGather("CA1", "hello");
    await gateway.handleGather("CA1", "again");

    expect(sessionsCreated).toBe(1);
  });

  test("handleGather routes the transcribed speech into the orchestrator and speaks the response", async () => {
    let receivedMessage = "";
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async (userId, message) => {
        receivedMessage = message;
        return "You are working on JARVIS.";
      }),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "what am I doing right now");
    const body = await response.text();

    expect(receivedMessage).toBe("what am I doing right now");
    expect(body).toContain("You are working on JARVIS.");
  });

  test("handleGather with no speech re-prompts instead of calling the orchestrator", async () => {
    let called = false;
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => {
        called = true;
        return "unused";
      }),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", null);
    const body = await response.text();

    expect(called).toBe(false);
    expect(body).toContain("catch that");
  });

  test("handleGather without a prior incoming call still works (creates a session lazily)", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "fine"),
      userId: "local-user",
    }));

    const response = await gateway.handleGather("CA-never-called", "hi");
    expect(response.status).toBe(200);
  });

  test("an orchestrator error becomes a spoken apology, not a crash", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => {
        throw new Error("boom");
      }),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "hello");
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("went wrong");
  });

  test("XML special characters in the response text are escaped", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => 'Tom & Jerry said "hi" <there>'),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "hello");
    const body = await response.text();

    expect(body).not.toContain("<there>");
    expect(body).toContain("&amp;");
    expect(body).toContain("&quot;");
  });

  test("handleCallEnded frees the session so a later gather creates a new one", async () => {
    let sessionsCreated = 0;
    const gateway = new TwilioVoiceGateway((): PhoneSession => {
      sessionsCreated++;
      return { orchestrator: makeStubOrchestrator(async () => "ok"), userId: "local-user" };
    });

    gateway.handleIncomingCall("CA1");
    expect(gateway.hasActiveSession("CA1")).toBe(true);

    gateway.handleCallEnded("CA1");
    expect(gateway.hasActiveSession("CA1")).toBe(false);

    await gateway.handleGather("CA1", "hi");
    expect(sessionsCreated).toBe(2);
  });
});
