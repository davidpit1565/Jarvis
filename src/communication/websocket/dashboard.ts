/**
 * A minimal, self-contained status dashboard for JARVIS Core — served
 * directly by the same Bun.serve process as everything else, no build
 * step or framework. First step toward a real visual layer: today it
 * only shows live status (devices, tools, phone gateway); it doesn't
 * control anything yet.
 *
 * Deliberately static HTML with client-side JS that polls GET /status —
 * no server-rendered data is interpolated into this string, so there's
 * no injection surface here even though the data it displays (device
 * names, etc.) originates from device agents.
 */
export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JARVIS</title>
<style>
  :root {
    --bg: #05070a;
    --panel: #0c1118;
    --border: #1c2733;
    --cyan: #4fd6e8;
    --cyan-dim: #2a5a63;
    --amber: #ffb454;
    --text: #d7e4ea;
    --text-dim: #6d8290;
    --ok: #4fe88a;
    --off: #ff5f5f;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: radial-gradient(circle at 50% -10%, #0d1a20 0%, var(--bg) 60%);
    color: var(--text);
    font-family: "SF Mono", "Consolas", "Menlo", monospace;
    min-height: 100vh;
    padding: 24px 16px 60px;
  }
  header {
    text-align: center;
    margin-bottom: 32px;
  }
  .core {
    width: 84px;
    height: 84px;
    margin: 0 auto 12px;
    border-radius: 50%;
    border: 2px solid var(--cyan);
    box-shadow: 0 0 24px 2px var(--cyan-dim), inset 0 0 16px var(--cyan-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    animation: pulse 2.4s ease-in-out infinite;
  }
  .core::after {
    content: "";
    width: 40px;
    height: 40px;
    border-radius: 50%;
    background: var(--cyan);
    box-shadow: 0 0 20px var(--cyan);
    opacity: 0.85;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 24px 2px var(--cyan-dim), inset 0 0 16px var(--cyan-dim); }
    50% { box-shadow: 0 0 40px 6px var(--cyan), inset 0 0 24px var(--cyan); }
  }
  h1 {
    letter-spacing: 0.3em;
    font-size: 15px;
    font-weight: 600;
    color: var(--cyan);
    margin: 0;
  }
  .subtitle {
    color: var(--text-dim);
    font-size: 12px;
    margin-top: 4px;
  }
  main {
    max-width: 720px;
    margin: 0 auto;
    display: grid;
    gap: 16px;
  }
  section {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px 18px;
  }
  section h2 {
    margin: 0 0 12px;
    font-size: 12px;
    letter-spacing: 0.15em;
    color: var(--text-dim);
    text-transform: uppercase;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 0;
    border-top: 1px solid var(--border);
    font-size: 13px;
  }
  .row:first-of-type { border-top: none; }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 8px;
    box-shadow: 0 0 6px currentColor;
  }
  .dot.ok { background: var(--ok); color: var(--ok); }
  .dot.off { background: var(--off); color: var(--off); }
  .dot.unknown { background: var(--text-dim); color: var(--text-dim); }
  .tag {
    display: inline-block;
    font-size: 11px;
    color: var(--amber);
    border: 1px solid var(--amber);
    border-radius: 4px;
    padding: 1px 6px;
    margin-left: 6px;
  }
  .empty {
    color: var(--text-dim);
    font-size: 13px;
    font-style: italic;
  }
  .tools {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .tool-chip {
    font-size: 12px;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 10px;
    color: var(--text);
  }
  .tool-chip.device { border-color: var(--cyan-dim); color: var(--cyan); }
  footer {
    text-align: center;
    color: var(--text-dim);
    font-size: 11px;
    margin-top: 32px;
  }
</style>
</head>
<body>
  <header>
    <div class="core"></div>
    <h1>JARVIS</h1>
    <div class="subtitle" id="statusline">connecting…</div>
  </header>
  <main>
    <section>
      <h2>Devices</h2>
      <div id="devices"><div class="empty">No devices registered yet.</div></div>
    </section>
    <section>
      <h2>Tools</h2>
      <div id="tools" class="tools"><div class="empty">Loading…</div></div>
    </section>
    <section>
      <h2>Phone gateway</h2>
      <div id="phone" class="row"><span class="empty">Loading…</span></div>
    </section>
  </main>
  <footer>refreshes every 3s</footer>
<script>
  function statusDot(status) {
    if (status === "online") return '<span class="dot ok"></span>';
    if (status === "offline") return '<span class="dot off"></span>';
    return '<span class="dot unknown"></span>';
  }

  async function refresh() {
    const line = document.getElementById("statusline");
    try {
      const res = await fetch("/status");
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      line.textContent = "online";

      const devicesEl = document.getElementById("devices");
      if (!data.devices.length) {
        devicesEl.innerHTML = '<div class="empty">No devices registered yet.</div>';
      } else {
        devicesEl.innerHTML = data.devices.map(function (d) {
          var role = d.role ? '<span class="tag">' + d.role + '</span>' : "";
          return '<div class="row">' + statusDot(d.status) + d.name + role + '</div>';
        }).join("");
      }

      const toolsEl = document.getElementById("tools");
      toolsEl.innerHTML = data.tools.length
        ? data.tools.map(function (t) {
            return '<span class="tool-chip ' + (t.target === "device" ? "device" : "") + '">' + t.name + '</span>';
          }).join("")
        : '<div class="empty">No tools registered.</div>';

      const phoneEl = document.getElementById("phone");
      phoneEl.innerHTML = data.phoneGatewayEnabled
        ? '<span><span class="dot ok"></span>enabled</span>'
        : '<span><span class="dot off"></span>disabled</span>';
    } catch (err) {
      line.textContent = "disconnected";
    }
  }

  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>
`;
