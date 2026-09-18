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

  test("includes <Start><Stream> on the greeting when an audio stream URL is configured", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      undefined,
      "wss://example.com/voice/audio-stream"
    );

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();
    expect(body).toContain("<Start>");
    expect(body).toContain('url="wss://example.com/voice/audio-stream"');
    expect(body).toContain('track="both_tracks"');
  });

  test("omits <Start><Stream> when no audio stream URL is configured", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();
    expect(body).not.toContain("<Start>");
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

  test("the greeting is spoken in both Hebrew and English", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();

    expect(body).toContain("שלום, כאן ג");
    expect(body).toContain("Hi, this is JARVIS");
  });

  test("Gather defaults to automatic Hebrew/English recognition", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();

    expect(body).toContain('language="multi"');
    expect(body).toContain('speechModel="deepgram_nova-3"');
  });

  test("a single BCP-47 gather language override drops the speechModel attribute", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      undefined,
      undefined,
      undefined,
      "he-IL"
    );

    const response = gateway.handleIncomingCall("CA1");
    const body = await response.text();

    expect(body).toContain('language="he-IL"');
    expect(body).not.toContain("speechModel");
  });

  test("a Hebrew reply from the brain is spoken with the Hebrew voice, not the English one", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "אתה עובד על ג'רביס."),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "מה אני עושה עכשיו");
    const body = await response.text();

    expect(body).toContain('voice="Google.he-IL-Wavenet-D"');
    expect(body).toContain('language="he-IL"');
    expect(body).toContain("אתה עובד על ג");
  });

  test("an English reply from the brain is spoken with the configured English voice, not the Hebrew one", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "You are working on JARVIS."),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "what am I doing right now");
    const body = await response.text();

    expect(body).toContain('voice="Polly.Matthew-Neural">You are working on JARVIS.</Say></Gather>');
  });

  test("a custom Hebrew voice is honored", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({
        orchestrator: makeStubOrchestrator(async () => "שלום"),
        userId: "local-user",
      }),
      undefined,
      undefined,
      "Google.he-IL-Wavenet-A"
    );

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "hi");
    const body = await response.text();

    expect(body).toContain('voice="Google.he-IL-Wavenet-A"');
  });

  test("the no-input and error prompts are also bilingual", async () => {
    const noInputGateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "unused"),
      userId: "local-user",
    }));
    noInputGateway.handleIncomingCall("CA1");
    const noInputBody = await (await noInputGateway.handleGather("CA1", null)).text();
    expect(noInputBody).toContain("catch that");
    expect(noInputBody).toContain("לא שמעתי");

    const errorGateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => {
        throw new Error("boom");
      }),
      userId: "local-user",
    }));
    errorGateway.handleIncomingCall("CA1");
    const errorBody = await (await errorGateway.handleGather("CA1", "hello")).text();
    expect(errorBody).toContain("went wrong");
    expect(errorBody).toContain("השתבש");
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

  test("a call is ended by JARVIS itself after too many turns, as a cost/abuse safety net", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "ok"),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    let lastBody = "";
    for (let i = 0; i < 41; i++) {
      const response = await gateway.handleGather("CA1", "hello");
      lastBody = await response.text();
    }

    expect(lastBody).toContain("<Hangup/>");
    expect(lastBody).not.toContain("<Gather");
  });

  test("a call well under the turn limit is unaffected", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "ok"),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    const response = await gateway.handleGather("CA1", "hello");
    const body = await response.text();

    expect(body).toContain("<Gather");
    expect(body).not.toContain("<Hangup/>");
  });

  test("handleCallEnded resets the turn count for a later call with the same CallSid", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "ok"),
      userId: "local-user",
    }));

    gateway.handleIncomingCall("CA1");
    for (let i = 0; i < 41; i++) await gateway.handleGather("CA1", "hello");
    gateway.handleCallEnded("CA1");

    gateway.handleIncomingCall("CA1"); // Twilio can reuse a CallSid in principle; treat it as a fresh call
    const response = await gateway.handleGather("CA1", "hello");
    const body = await response.text();

    expect(body).toContain("<Gather");
  });

  test("handleWakeUpCallConnected speaks the brain's own opening line", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused (regular session)"), userId: "local-user" }),
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        orchestrator: makeStubOrchestrator(async () => "Good morning! You have a meeting at 9."),
        userId: "local-user",
      })
    );

    const response = await gateway.handleWakeUpCallConnected("CA-wakeup");
    const body = await response.text();

    expect(body).toContain("Good morning! You have a meeting at 9.");
    expect(body).toContain("<Gather");
  });

  test("handleWakeUpCallConnected falls back to a canned greeting if the brain call fails", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" }),
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        orchestrator: makeStubOrchestrator(async () => {
          throw new Error("boom");
        }),
        userId: "local-user",
      })
    );

    const response = await gateway.handleWakeUpCallConnected("CA-wakeup-2");
    const body = await response.text();

    expect(body).toContain("Good morning");
    expect(body).toContain("<Gather");
  });

  test("a follow-up handleGather for a wake-up call's CallSid finds the same session", async () => {
    const gateway = new TwilioVoiceGateway(
      () => ({ orchestrator: makeStubOrchestrator(async () => "unused (regular session)"), userId: "local-user" }),
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({ orchestrator: makeStubOrchestrator(async () => "wake-up opener"), userId: "local-user" })
    );

    await gateway.handleWakeUpCallConnected("CA-wakeup-3");
    const response = await gateway.handleGather("CA-wakeup-3", "I'm up");
    const body = await response.text();

    expect(body).toContain("<Gather");
  });

  test("defaults the wake-up session factory to the regular one when not given", async () => {
    const gateway = new TwilioVoiceGateway(() => ({
      orchestrator: makeStubOrchestrator(async () => "same factory response"),
      userId: "local-user",
    }));

    const response = await gateway.handleWakeUpCallConnected("CA-wakeup-4");
    const body = await response.text();

    expect(body).toContain("same factory response");
  });
});
