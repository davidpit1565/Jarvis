import { describe, test, expect } from "bun:test";
import { computeAudioLevel } from "@/communication/phone/audioLevel";

// µ-law silence is conventionally encoded as 0xFF (positive zero) or 0x7F
// (negative zero) — both decode to 0 in standard G.711 µ-law.
function silenceChunk(length: number): string {
  return Buffer.alloc(length, 0xff).toString("base64");
}

// 0x00 is the maximum-magnitude negative µ-law sample (loudest possible).
function loudChunk(length: number): string {
  return Buffer.alloc(length, 0x00).toString("base64");
}

describe("computeAudioLevel", () => {
  test("returns 0 for an empty payload", () => {
    expect(computeAudioLevel("")).toBe(0);
  });

  test("returns 0 (or very close to it) for silence", () => {
    const level = computeAudioLevel(silenceChunk(160));
    expect(level).toBeCloseTo(0, 5);
  });

  test("returns a high level for a maximum-amplitude chunk", () => {
    const level = computeAudioLevel(loudChunk(160));
    expect(level).toBeGreaterThan(0.9);
  });

  test("never exceeds 1 even for the loudest possible input", () => {
    const level = computeAudioLevel(loudChunk(320));
    expect(level).toBeLessThanOrEqual(1);
  });

  test("a louder chunk produces a higher level than a quieter one", () => {
    // 0x30 in mu-law decodes to a small-magnitude sample (higher byte value
    // toward 0x7F/0xFF is quieter for the positive/negative halves respectively).
    const quiet = computeAudioLevel(Buffer.alloc(160, 0xe0).toString("base64"));
    const loud = computeAudioLevel(loudChunk(160));
    expect(loud).toBeGreaterThan(quiet);
  });
});
