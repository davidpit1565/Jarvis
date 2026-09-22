import { describe, test, expect, afterEach } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import { DeviceRegistry } from "@/devices/registry/DeviceRegistry";
import { PairingService } from "@/devices/pairing/PairingService";
import { DeviceConnectionManager } from "@/communication/websocket/DeviceConnectionManager";
import { JarvisWebSocketServer } from "@/communication/websocket/JarvisWebSocketServer";

const originalFetch = global.fetch;
let activeHandle: { stop: () => void } | undefined;

afterEach(() => {
  activeHandle?.stop();
  activeHandle = undefined;
  global.fetch = originalFetch;
});

function setupServer() {
  const eventBus = new EventBus();
  const server = new JarvisWebSocketServer({
    deviceRegistry: new DeviceRegistry(),
    deviceConnectionManager: new DeviceConnectionManager(eventBus),
    pairingService: new PairingService(),
    eventBus,
  });
  const handle = server.start(0);
  activeHandle = handle;
  return handle;
}

// The route handler's own outbound fetch to pollinations.ai shares the
// same global `fetch` the test itself uses to call its local server —
// mocking global.fetch has to pass local-server requests through to the
// real implementation, or the test's own outer request never reaches
// the server at all.
function mockPollinationsFetch(handler: (url: string) => Promise<Response>) {
  global.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("localhost")) return originalFetch(input, init);
    return handler(url);
  }) as unknown as typeof fetch;
}

describe("GET /image-proxy", () => {
  test("re-serves a real pollinations.ai image with Content-Disposition: attachment, forcing a real download", async () => {
    const handle = setupServer();
    mockPollinationsFetch(async (url) => {
      expect(url).toBe("https://image.pollinations.ai/prompt/a%20cat");
      return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "Content-Type": "image/jpeg" } });
    });

    const target = encodeURIComponent("https://image.pollinations.ai/prompt/a%20cat");
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy?url=${target}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  test("400s with no url parameter", async () => {
    const handle = setupServer();
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy`);
    expect(response.status).toBe(400);
  });

  test("400s for a URL on any host other than image.pollinations.ai (SSRF guard)", async () => {
    const handle = setupServer();
    let fetchCalled = false;
    mockPollinationsFetch(async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    });

    const target = encodeURIComponent("https://internal.example.com/secrets");
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy?url=${target}`);

    expect(response.status).toBe(400);
    expect(fetchCalled).toBe(false);
  });

  test("400s for a non-https URL on the right host (e.g. http://, file://)", async () => {
    const handle = setupServer();
    const target = encodeURIComponent("http://image.pollinations.ai/prompt/x");
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy?url=${target}`);
    expect(response.status).toBe(400);
  });

  test("502s when the upstream fetch fails", async () => {
    const handle = setupServer();
    mockPollinationsFetch(async () => {
      throw new Error("network down");
    });

    const target = encodeURIComponent("https://image.pollinations.ai/prompt/x");
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy?url=${target}`);
    expect(response.status).toBe(502);
  });

  test("502s when the upstream returns a non-ok status", async () => {
    const handle = setupServer();
    mockPollinationsFetch(async () => new Response(null, { status: 404 }));

    const target = encodeURIComponent("https://image.pollinations.ai/prompt/x");
    const response = await originalFetch(`http://localhost:${handle.port}/image-proxy?url=${target}`);
    expect(response.status).toBe(502);
  });
});
