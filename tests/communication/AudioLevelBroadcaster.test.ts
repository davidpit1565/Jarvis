import { describe, test, expect } from "bun:test";
import { AudioLevelBroadcaster } from "@/communication/websocket/AudioLevelBroadcaster";

function makeSink() {
  const received: string[] = [];
  return { sink: { send: (data: string) => received.push(data) }, received };
}

describe("AudioLevelBroadcaster", () => {
  test("delivers a broadcast to every added viewer", () => {
    const broadcaster = new AudioLevelBroadcaster();
    const a = makeSink();
    const b = makeSink();
    broadcaster.addViewer(a.sink);
    broadcaster.addViewer(b.sink);

    broadcaster.broadcast(0.42, "inbound");

    expect(JSON.parse(a.received[0]!)).toEqual({ type: "level", level: 0.42, track: "inbound" });
    expect(JSON.parse(b.received[0]!)).toEqual({ type: "level", level: 0.42, track: "inbound" });
  });

  test("a removed viewer no longer receives broadcasts", () => {
    const broadcaster = new AudioLevelBroadcaster();
    const a = makeSink();
    broadcaster.addViewer(a.sink);
    broadcaster.removeViewer(a.sink);

    broadcaster.broadcast(0.5, "outbound");

    expect(a.received).toEqual([]);
  });

  test("viewerCount reflects current viewers", () => {
    const broadcaster = new AudioLevelBroadcaster();
    const a = makeSink();
    expect(broadcaster.viewerCount).toBe(0);
    broadcaster.addViewer(a.sink);
    expect(broadcaster.viewerCount).toBe(1);
    broadcaster.removeViewer(a.sink);
    expect(broadcaster.viewerCount).toBe(0);
  });

  test("broadcasting with no viewers does not throw", () => {
    const broadcaster = new AudioLevelBroadcaster();
    expect(() => broadcaster.broadcast(0.1, "inbound")).not.toThrow();
  });
});
