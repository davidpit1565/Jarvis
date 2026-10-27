import { describe, test, expect } from "bun:test";
import { PassphraseSpeakerAuthenticator } from "@/core/confirmation/SpeakerAuthenticator";

describe("PassphraseSpeakerAuthenticator", () => {
  test("rejects when no passphrase is configured", () => {
    const auth = new PassphraseSpeakerAuthenticator(() => null);
    const result = auth.authenticate({ deviceId: "mac-1", text: "open sesame" });
    expect(result.authenticated).toBe(false);
  });

  test("authenticates an exact match", () => {
    const auth = new PassphraseSpeakerAuthenticator(() => "open sesame");
    expect(auth.authenticate({ deviceId: "mac-1", text: "open sesame" }).authenticated).toBe(true);
  });

  test("authenticates despite case/punctuation/whitespace differences from speech-to-text", () => {
    const auth = new PassphraseSpeakerAuthenticator(() => "open sesame");
    expect(auth.authenticate({ deviceId: "mac-1", text: "Open Sesame." }).authenticated).toBe(true);
    expect(auth.authenticate({ deviceId: "mac-1", text: "  open   sesame  " }).authenticated).toBe(true);
  });

  test("rejects a wrong phrase", () => {
    const auth = new PassphraseSpeakerAuthenticator(() => "open sesame");
    expect(auth.authenticate({ deviceId: "mac-1", text: "close sesame" }).authenticated).toBe(false);
  });

  test("always re-reads the current passphrase via the thunk, not a snapshot taken at construction", () => {
    let current = "first phrase";
    const auth = new PassphraseSpeakerAuthenticator(() => current);
    expect(auth.authenticate({ deviceId: "mac-1", text: "first phrase" }).authenticated).toBe(true);

    current = "second phrase";
    expect(auth.authenticate({ deviceId: "mac-1", text: "first phrase" }).authenticated).toBe(false);
    expect(auth.authenticate({ deviceId: "mac-1", text: "second phrase" }).authenticated).toBe(true);
  });
});
