import { describe, test, expect } from "bun:test";
import { TwilioSmsGateway, type SmsSession } from "@/communication/phone/TwilioSmsGateway";
import type { Orchestrator } from "@/core/orchestrator/Orchestrator";

function makeStubOrchestrator(handle: (userId: string, message: string) => Promise<string>): Orchestrator {
  return { handleUserMessage: handle } as unknown as Orchestrator;
}

async function textOf(response: Response): Promise<string> {
  return response.text();
}

describe("TwilioSmsGateway.handleIncomingSms", () => {
  test("replies with the orchestrator's response wrapped in TwiML", async () => {
    const gateway = new TwilioSmsGateway(
      (): SmsSession => ({ orchestrator: makeStubOrchestrator(async () => "Hello back"), userId: "local-user" })
    );

    const response = await gateway.handleIncomingSms("+15551234567", "hi");

    expect(response.headers.get("Content-Type")).toBe("text/xml");
    const body = await textOf(response);
    expect(body).toContain("<Message>Hello back</Message>");
  });

  test("returns an empty TwiML response for a blank message", async () => {
    const gateway = new TwilioSmsGateway(
      (): SmsSession => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" })
    );

    const response = await gateway.handleIncomingSms("+15551234567", "   ");
    const body = await textOf(response);

    expect(body).not.toContain("<Message>");
  });

  test("replies with a graceful not-yet-supported message for an MMS with no caption, instead of staying silent", async () => {
    const gateway = new TwilioSmsGateway(
      (): SmsSession => ({ orchestrator: makeStubOrchestrator(async () => "unused"), userId: "local-user" })
    );

    const response = await gateway.handleIncomingSms("+15551234567", "", 2);
    const body = await textOf(response);

    expect(body).toContain("<Message>");
    expect(body).toMatch(/photos or attachments/i);
  });

  test("tells the model about attached media it can't see, alongside a caption", async () => {
    let messageSeenByBrain = "";
    const gateway = new TwilioSmsGateway((): SmsSession => ({
      orchestrator: makeStubOrchestrator(async (_userId, message) => {
        messageSeenByBrain = message;
        return "ok";
      }),
      userId: "local-user",
    }));

    await gateway.handleIncomingSms("+15551234567", "check this out", 1);

    expect(messageSeenByBrain).toContain("check this out");
    expect(messageSeenByBrain).toMatch(/attached 1 image/i);
  });

  test("reuses the same session/conversation across multiple texts from the same number", async () => {
    let sessionsCreated = 0;
    const gateway = new TwilioSmsGateway((): SmsSession => {
      sessionsCreated++;
      return { orchestrator: makeStubOrchestrator(async () => "reply"), userId: "local-user" };
    });

    await gateway.handleIncomingSms("+15551234567", "first");
    await gateway.handleIncomingSms("+15551234567", "second");

    expect(sessionsCreated).toBe(1);
  });

  test("gives two different numbers separate sessions", async () => {
    let sessionsCreated = 0;
    const gateway = new TwilioSmsGateway((): SmsSession => {
      sessionsCreated++;
      return { orchestrator: makeStubOrchestrator(async () => "reply"), userId: "local-user" };
    });

    await gateway.handleIncomingSms("+15551234567", "hi");
    await gateway.handleIncomingSms("+15559999999", "hi");

    expect(sessionsCreated).toBe(2);
  });

  test("sends a fallback error reply if the orchestrator throws, without throwing itself", async () => {
    const gateway = new TwilioSmsGateway((): SmsSession => ({
      orchestrator: makeStubOrchestrator(async () => {
        throw new Error("brain exploded");
      }),
      userId: "local-user",
    }));

    const response = await gateway.handleIncomingSms("+15551234567", "hi");
    const body = await textOf(response);

    expect(body).toMatch(/something went wrong/i);
  });

  test("escapes XML-significant characters in the reply", async () => {
    const gateway = new TwilioSmsGateway((): SmsSession => ({
      orchestrator: makeStubOrchestrator(async () => "A & B < C"),
      userId: "local-user",
    }));

    const response = await gateway.handleIncomingSms("+15551234567", "hi");
    const body = await textOf(response);

    expect(body).toContain("A &amp; B &lt; C");
  });
});
