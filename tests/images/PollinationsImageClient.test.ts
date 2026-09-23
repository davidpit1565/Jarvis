import { describe, test, expect } from "bun:test";
import { PollinationsImageClient } from "@/images/PollinationsImageClient";

describe("PollinationsImageClient.buildImageUrl", () => {
  test("builds a URL-encoded prompt against the real pollinations.ai endpoint", () => {
    const client = new PollinationsImageClient();
    const url = client.buildImageUrl("a cute robot & friends");

    expect(url.startsWith("https://image.pollinations.ai/prompt/")).toBe(true);
    expect(url).toContain(encodeURIComponent("a cute robot & friends"));
  });

  test("defaults to 1024x1024", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset"));

    expect(url.searchParams.get("width")).toBe("1024");
    expect(url.searchParams.get("height")).toBe("1024");
  });

  test("honors explicit width/height", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset", { width: 512, height: 768 }));

    expect(url.searchParams.get("width")).toBe("512");
    expect(url.searchParams.get("height")).toBe("768");
  });

  test("clamps an oversized dimension to the max", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset", { width: 10000 }));

    expect(url.searchParams.get("width")).toBe("1536");
  });

  test("falls back to the default for an invalid dimension", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset", { width: -5, height: NaN }));

    expect(url.searchParams.get("width")).toBe("1024");
    expect(url.searchParams.get("height")).toBe("1024");
  });

  test("clamps a tiny positive value that would otherwise round to 0 up to a sane minimum", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset", { width: 0.4 }));

    expect(url.searchParams.get("width")).toBe("64");
  });

  test("includes a seed when given, for reproducibility", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset", { seed: 42 }));

    expect(url.searchParams.get("seed")).toBe("42");
  });

  test("always requests nologo, to avoid Pollinations' own watermark on every image", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset"));

    expect(url.searchParams.get("nologo")).toBe("true");
  });

  test("omits seed when not given", () => {
    const client = new PollinationsImageClient();
    const url = new URL(client.buildImageUrl("sunset"));

    expect(url.searchParams.has("seed")).toBe(false);
  });
});
