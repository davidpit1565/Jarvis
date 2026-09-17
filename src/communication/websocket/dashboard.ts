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
  .hologram {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    max-width: 720px;
    margin: 0 auto 8px;
  }
  .side-panel {
    display: none;
    flex: 1;
    text-align: left;
    font-size: 10px;
    line-height: 1.7;
    color: var(--cyan-dim);
    white-space: nowrap;
    overflow: hidden;
  }
  .side-panel.right { text-align: right; }
  .side-panel .readout-label {
    color: var(--text-dim);
    letter-spacing: 0.1em;
  }
  .side-panel .readout-value {
    color: var(--cyan);
  }
  @media (min-width: 640px) {
    .side-panel { display: block; }
  }
  #core-canvas {
    width: 220px;
    height: 220px;
    filter: drop-shadow(0 0 18px var(--cyan-dim));
  }
  @media (prefers-reduced-motion: reduce) {
    #core-canvas { animation: none; }
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
  .glitch {
    animation: glitchText 0.25s steps(2, jump-none) 3;
  }
  @keyframes glitchText {
    0%, 100% { transform: translate(0, 0); opacity: 1; }
    25% { transform: translate(-1px, 0.5px); opacity: 0.7; text-shadow: 1px 0 var(--off); }
    50% { transform: translate(1px, -0.5px); opacity: 0.9; text-shadow: -1px 0 var(--cyan); }
    75% { transform: translate(-1px, 0); opacity: 0.8; }
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
  .activity {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-height: 220px;
    overflow-y: auto;
  }
  .activity-item {
    font-size: 12px;
    color: var(--text-dim);
    display: flex;
    gap: 8px;
    animation: fadeIn 0.4s ease-out;
  }
  .activity-item .time {
    color: var(--cyan-dim);
    flex-shrink: 0;
  }
  .activity-item .msg { color: var(--text); }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(-4px); }
    to { opacity: 1; transform: translateY(0); }
  }
  #statusline.typing::after {
    content: "▍";
    animation: blink 1s step-end infinite;
  }
  @keyframes blink { 50% { opacity: 0; } }
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
    <div class="hologram">
      <div class="side-panel" id="side-left"></div>
      <canvas id="core-canvas" width="220" height="220"></canvas>
      <div class="side-panel right" id="side-right"></div>
    </div>
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
    <section>
      <h2>Activity</h2>
      <div id="activity" class="activity"><div class="empty">Nothing yet.</div></div>
    </section>
  </main>
  <footer>refreshes every 3s</footer>
<script>
  // --- Holographic core: a hand-rolled wireframe sphere, no 3D library.
  // Inspired by a reference (an AI-generated cinematic hologram render) the
  // user shared — a literal photoreal face isn't realistic to reproduce as
  // live, real-time browser graphics, so this aims for the same idea (a
  // rotating holographic "head/core" with glitch/scan artifacts) using
  // plain wireframe geometry instead.
  (function setupCore() {
    var canvas = document.getElementById("core-canvas");
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    var cx = w / 2, cy = h / 2;
    var radius = 70;

    var points = [];
    var RINGS = 14, SEGMENTS = 20;
    for (var ring = 0; ring <= RINGS; ring++) {
      var lat = (ring / RINGS) * Math.PI - Math.PI / 2;
      for (var seg = 0; seg < SEGMENTS; seg++) {
        var lon = (seg / SEGMENTS) * Math.PI * 2;
        points.push({
          ring: ring,
          seg: seg,
          x: Math.cos(lat) * Math.cos(lon),
          y: Math.sin(lat),
          z: Math.cos(lat) * Math.sin(lon),
        });
      }
    }

    var angle = 0;
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    var glitchUntil = 0;

    function project(p, rotY, rotX) {
      var x = p.x * Math.cos(rotY) - p.z * Math.sin(rotY);
      var z = p.x * Math.sin(rotY) + p.z * Math.cos(rotY);
      var y = p.y * Math.cos(rotX) - z * Math.sin(rotX);
      z = p.y * Math.sin(rotX) + z * Math.cos(rotX);
      var scale = 1.4 / (2.4 + z);
      return { x: cx + x * radius * scale, y: cy + y * radius * scale, z: z, depth: scale };
    }

    function draw() {
      ctx.clearRect(0, 0, w, h);
      var now = performance.now();
      var isGlitching = now < glitchUntil;
      var rotY = angle;
      var rotX = 0.15 + Math.sin(angle * 0.4) * 0.05;

      var projected = points.map(function (p) { return project(p, rotY, rotX); });

      function drawEdge(a, b, alpha) {
        var jitterX = isGlitching ? (Math.random() - 0.5) * 4 : 0;
        ctx.strokeStyle = "rgba(79, 214, 232, " + alpha + ")";
        ctx.beginPath();
        ctx.moveTo(a.x + jitterX, a.y);
        ctx.lineTo(b.x + jitterX, b.y);
        ctx.stroke();
      }

      for (var ring = 0; ring <= RINGS; ring++) {
        for (var seg = 0; seg < SEGMENTS; seg++) {
          var i = ring * SEGMENTS + seg;
          var p = projected[i];
          var alpha = Math.max(0.06, Math.min(0.55, 0.25 + p.z * 0.3));
          var next = projected[ring * SEGMENTS + ((seg + 1) % SEGMENTS)];
          drawEdge(p, next, alpha);
          if (ring < RINGS) {
            var below = projected[i + SEGMENTS];
            drawEdge(p, below, alpha * 0.7);
          }
        }
      }

      // Core glow at center
      var glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
      glow.addColorStop(0, "rgba(79, 214, 232, 0.9)");
      glow.addColorStop(1, "rgba(79, 214, 232, 0)");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, 22, 0, Math.PI * 2);
      ctx.fill();

      if (!reduceMotion) angle += 0.006;
      requestAnimationFrame(draw);
    }

    // Occasionally trigger a brief glitch burst, echoing the reference's
    // data-corruption look — but this is cosmetic idle animation, not tied
    // to any real signal (a real fault is shown via the side panels/status
    // line instead, so the glitch here never implies an actual problem).
    if (!reduceMotion) {
      setInterval(function () {
        if (Math.random() < 0.15) glitchUntil = performance.now() + 180;
      }, 4000);
      requestAnimationFrame(draw);
    } else {
      draw();
    }
  })();

  function renderSidePanel(el, rows) {
    el.innerHTML = rows
      .map(function (r) {
        return '<div><span class="readout-label">' + r[0] + '</span> <span class="readout-value">' + r[1] + "</span></div>";
      })
      .join("");
  }

  function escapeHtml(text) {
    var div = document.createElement("div");
    div.textContent = String(text == null ? "" : text);
    return div.innerHTML;
  }

  function statusDot(status) {
    if (status === "online") return '<span class="dot ok"></span>';
    if (status === "offline") return '<span class="dot off"></span>';
    return '<span class="dot unknown"></span>';
  }

  function typeBootLine() {
    var line = document.getElementById("statusline");
    var text = "systems online";
    line.classList.add("typing");
    line.textContent = "";
    var i = 0;
    var interval = setInterval(function () {
      line.textContent = text.slice(0, i + 1);
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        line.classList.remove("typing");
      }
    }, 40);
  }

  function timeAgo(isoString) {
    var seconds = Math.max(0, Math.floor((Date.now() - new Date(isoString).getTime()) / 1000));
    if (seconds < 5) return "now";
    if (seconds < 60) return seconds + "s ago";
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return Math.floor(minutes / 60) + "h ago";
  }

  var bootedOnce = false;
  var lastCounts = null;

  async function refresh() {
    const line = document.getElementById("statusline");
    try {
      const res = await fetch("/status");
      if (!res.ok) throw new Error("bad response");
      const data = await res.json();
      if (!bootedOnce) {
        bootedOnce = true;
        typeBootLine();
      } else if (!line.classList.contains("typing")) {
        line.textContent = "systems online";
      }

      const onlineDevices = data.devices.filter(function (d) { return d.status === "online"; }).length;
      const counts = data.devices.length + ":" + onlineDevices + ":" + data.tools.length + ":" + (data.phoneGatewayEnabled ? 1 : 0);
      const changed = lastCounts !== null && lastCounts !== counts;
      lastCounts = counts;

      const leftEl = document.getElementById("side-left");
      const rightEl = document.getElementById("side-right");
      renderSidePanel(leftEl, [
        ["DEVICES", data.devices.length],
        ["ONLINE", onlineDevices],
        ["TOOLS", data.tools.length],
      ]);
      renderSidePanel(rightEl, [
        ["PHONE", data.phoneGatewayEnabled ? "LIVE" : "OFF"],
        ["EVENTS", (data.activity && data.activity.length) || 0],
        ["MODE", "NOMINAL"],
      ]);
      if (changed) {
        [leftEl, rightEl].forEach(function (el) {
          el.classList.remove("glitch");
          void el.offsetWidth; // restart the animation
          el.classList.add("glitch");
        });
      }

      const devicesEl = document.getElementById("devices");
      if (!data.devices.length) {
        devicesEl.innerHTML = '<div class="empty">No devices registered yet.</div>';
      } else {
        devicesEl.innerHTML = data.devices.map(function (d) {
          var role = d.role ? '<span class="tag">' + escapeHtml(d.role) + '</span>' : "";
          return '<div class="row">' + statusDot(d.status) + escapeHtml(d.name) + role + '</div>';
        }).join("");
      }

      const toolsEl = document.getElementById("tools");
      toolsEl.innerHTML = data.tools.length
        ? data.tools.map(function (t) {
            return '<span class="tool-chip ' + (t.target === "device" ? "device" : "") + '">' + escapeHtml(t.name) + '</span>';
          }).join("")
        : '<div class="empty">No tools registered.</div>';

      const phoneEl = document.getElementById("phone");
      phoneEl.innerHTML = data.phoneGatewayEnabled
        ? '<span><span class="dot ok"></span>enabled</span>'
        : '<span><span class="dot off"></span>disabled</span>';

      const activityEl = document.getElementById("activity");
      activityEl.innerHTML = data.activity && data.activity.length
        ? data.activity.map(function (a) {
            return '<div class="activity-item"><span class="time">' + timeAgo(a.timestamp) +
              '</span><span class="msg">' + escapeHtml(a.message) + '</span></div>';
          }).join("")
        : '<div class="empty">Nothing yet.</div>';
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
