import { describe, test, expect } from "bun:test";
import { parseClientMessage } from "@/communication/websocket/protocol";

describe("WebSocket protocol", () => {
  test("parses a valid command message", () => {
    const message = parseClientMessage(JSON.stringify({ type: "command", deviceId: "mac-1", payload: {} }));
    expect(message).toEqual({ type: "command", deviceId: "mac-1", payload: {} });
  });

  test("parses a valid tool_result message", () => {
    const message = parseClientMessage(
      JSON.stringify({ type: "tool_result", requestId: "req-1", result: { ok: true } })
    );
    expect(message).toEqual({ type: "tool_result", requestId: "req-1", result: { ok: true } });
  });

  test("rejects invalid JSON", () => {
    expect(parseClientMessage("not json")).toBeNull();
  });

  test("rejects a message with an unknown type", () => {
    expect(parseClientMessage(JSON.stringify({ type: "mystery" }))).toBeNull();
  });

  test("rejects a command message missing deviceId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "command", payload: {} }))).toBeNull();
  });
});
