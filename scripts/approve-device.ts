/**
 * CLI to approve a device's pending pairing code against a running JARVIS
 * Core instance. Talks to Core over plain HTTP (POST /pairing/approve) —
 * a separate process has no access to Core's in-memory PairingService, so
 * this is intentionally a thin client, not a reimplementation of the logic.
 *
 * Usage: bun run approve-device <deviceId> <code>
 */

const [deviceId, code] = process.argv.slice(2);

if (!deviceId || !code) {
  console.error("Usage: bun run approve-device <deviceId> <code>");
  process.exit(1);
}

const port = process.env.JARVIS_PORT ?? "4770";
// JARVIS_CORE_URL overrides the default localhost target, e.g.
// https://<your-app>.fly.dev, so this CLI also works against a deployed
// Core instance, not just one running on this machine.
const baseUrl = process.env.JARVIS_CORE_URL ?? `http://localhost:${port}`;
const url = `${baseUrl}/pairing/approve`;
const adminToken = process.env.JARVIS_ADMIN_TOKEN;

let response: Response;
try {
  response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { "X-Jarvis-Admin-Token": adminToken } : {}),
    },
    body: JSON.stringify({ deviceId, code }),
  });
} catch (error) {
  const message = error instanceof Error ? error.message : "Unknown network error";
  console.error(`Could not reach JARVIS Core at ${url}: ${message}`);
  console.error(
    process.env.JARVIS_CORE_URL
      ? "Is the deployed Core instance reachable at that URL?"
      : `Is "bun run dev" running, and is JARVIS_PORT set to ${port}?`
  );
  process.exit(1);
}

const rawText = await response.text();
let body: { success: boolean; error?: string };
try {
  body = JSON.parse(rawText);
} catch {
  console.error(`Core returned a non-JSON response (HTTP ${response.status}):`);
  console.error(rawText);
  process.exit(1);
}

if (!response.ok || !body.success) {
  console.error(`Pairing approval failed: ${body.error ?? response.statusText}`);
  process.exit(1);
}

console.log(`Device "${deviceId}" approved. Its credential was sent to the device if it is still connected.`);
