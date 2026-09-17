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
const url = `http://localhost:${port}/pairing/approve`;

const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ deviceId, code }),
});

const body = (await response.json()) as { success: boolean; error?: string };

if (!response.ok || !body.success) {
  console.error(`Pairing approval failed: ${body.error ?? response.statusText}`);
  process.exit(1);
}

console.log(`Device "${deviceId}" approved. Its credential was sent to the device if it is still connected.`);
