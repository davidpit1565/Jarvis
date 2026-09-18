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
/**
 * Shared browser-side WebAuthn helpers (Face ID / Touch ID / platform
 * passkeys), used by both the dashboard's "set up Face ID" banner and the
 * lock screen's "unlock" button. Hand-written rather than pulling in
 * @simplewebauthn/browser, to keep this dashboard dependency-free and
 * self-contained (no build step, no CDN script) — the conversions here
 * (base64url <-> ArrayBuffer, and shaping the browser's PublicKeyCredential
 * into the JSON @simplewebauthn/server expects) are exactly what that
 * package does, just inlined.
 */
const WEBAUTHN_CLIENT_JS = `
  function bufToBase64url(buf) {
    var bytes = new Uint8Array(buf);
    var str = "";
    for (var i = 0; i < bytes.byteLength; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }
  function base64urlToBuf(base64url) {
    var base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
    var pad = base64.length % 4 === 0 ? "" : "=".repeat(4 - (base64.length % 4));
    var str = atob(base64 + pad);
    var bytes = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return bytes.buffer;
  }

  async function setupFaceId() {
    var adminToken = prompt("Enter your JARVIS_ADMIN_TOKEN to register this device's Face ID / Touch ID:");
    if (!adminToken) return;
    try {
      var optionsRes = await fetch("/auth/register-options", {
        method: "POST",
        headers: { "X-Jarvis-Admin-Token": adminToken },
      });
      if (!optionsRes.ok) throw new Error("Could not start registration — wrong admin token?");
      var options = await optionsRes.json();
      options.challenge = base64urlToBuf(options.challenge);
      options.user.id = base64urlToBuf(options.user.id);
      if (options.excludeCredentials) {
        options.excludeCredentials = options.excludeCredentials.map(function (c) {
          return Object.assign({}, c, { id: base64urlToBuf(c.id) });
        });
      }
      var credential = await navigator.credentials.create({ publicKey: options });
      var payload = {
        response: {
          id: credential.id,
          rawId: bufToBase64url(credential.rawId),
          type: credential.type,
          response: {
            attestationObject: bufToBase64url(credential.response.attestationObject),
            clientDataJSON: bufToBase64url(credential.response.clientDataJSON),
          },
          clientExtensionResults: credential.getClientExtensionResults(),
        },
      };
      var verifyRes = await fetch("/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Jarvis-Admin-Token": adminToken },
        body: JSON.stringify(payload),
      });
      if (!verifyRes.ok) throw new Error("Registration could not be verified");
      alert("Face ID / Touch ID registered. Reloading.");
      location.reload();
    } catch (err) {
      alert("Setup failed: " + (err && err.message ? err.message : err));
    }
  }

  async function unlockWithFaceId() {
    try {
      var optionsRes = await fetch("/auth/login-options");
      var options = await optionsRes.json();
      options.challenge = base64urlToBuf(options.challenge);
      if (options.allowCredentials) {
        options.allowCredentials = options.allowCredentials.map(function (c) {
          return Object.assign({}, c, { id: base64urlToBuf(c.id) });
        });
      }
      var assertion = await navigator.credentials.get({ publicKey: options });
      var payload = {
        response: {
          id: assertion.id,
          rawId: bufToBase64url(assertion.rawId),
          type: assertion.type,
          response: {
            authenticatorData: bufToBase64url(assertion.response.authenticatorData),
            clientDataJSON: bufToBase64url(assertion.response.clientDataJSON),
            signature: bufToBase64url(assertion.response.signature),
            userHandle: assertion.response.userHandle ? bufToBase64url(assertion.response.userHandle) : undefined,
          },
          clientExtensionResults: assertion.getClientExtensionResults(),
        },
      };
      var loginRes = await fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(payload),
      });
      if (!loginRes.ok) throw new Error("Face ID was not recognized");
      location.reload();
    } catch (err) {
      var box = document.getElementById("unlock-error");
      if (box) box.textContent = "Unlock failed: " + (err && err.message ? err.message : err);
    }
  }
`;

/**
 * Shown instead of DASHBOARD_HTML when Face ID/Touch ID protection is
 * configured (at least one credential registered) and the request has no
 * valid session cookie. The unlock ceremony itself proves identity — this
 * page needs no server-rendered data, so (like the dashboard) it carries
 * no injection surface.
 */
export const LOCK_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>JARVIS — Locked</title>
<style>
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    background: radial-gradient(circle at 50% 30%, #0d1a20 0%, #05070a 60%);
    color: #d7e4ea;
    font-family: "SF Mono", "Consolas", "Menlo", monospace;
  }
  h1 { letter-spacing: 0.3em; color: #4fd6e8; font-size: 16px; }
  button {
    margin-top: 24px;
    background: transparent;
    border: 1px solid #4fd6e8;
    color: #4fd6e8;
    padding: 10px 20px;
    border-radius: 8px;
    font-family: inherit;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { background: rgba(79, 214, 232, 0.1); }
  #unlock-error { color: #ff5f5f; font-size: 12px; margin-top: 12px; max-width: 320px; text-align: center; }
</style>
</head>
<body>
  <h1>JARVIS — LOCKED</h1>
  <button onclick="unlockWithFaceId()">Unlock with Face ID / Touch ID</button>
  <div id="unlock-error"></div>
<script>${WEBAUTHN_CLIENT_JS}</script>
</body>
</html>
`;

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
    background:
      repeating-linear-gradient(0deg, rgba(79, 214, 232, 0.03) 0px, rgba(79, 214, 232, 0.03) 1px, transparent 1px, transparent 32px),
      repeating-linear-gradient(90deg, rgba(79, 214, 232, 0.03) 0px, rgba(79, 214, 232, 0.03) 1px, transparent 1px, transparent 32px),
      radial-gradient(circle at 50% -10%, #0d1a20 0%, var(--bg) 60%);
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
  .hologram-ring {
    position: relative;
    width: 260px;
    height: 260px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hologram-ring::before {
    content: "";
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 1px solid var(--cyan-dim);
    opacity: 0.5;
  }
  .hologram-ring::after {
    content: "";
    position: absolute;
    inset: 8px;
    border-radius: 50%;
    background: conic-gradient(from 0deg, transparent 0deg 300deg, rgba(79, 214, 232, 0.45) 360deg);
    animation: radarSweep 4s linear infinite;
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px));
  }
  @keyframes radarSweep {
    to { transform: rotate(360deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .hologram-ring::after { animation: none; }
  }
  .hologram-frame {
    position: relative;
    width: 220px;
    height: 220px;
    border-radius: 12px;
    overflow: hidden;
    filter: drop-shadow(0 0 18px var(--cyan-dim));
    animation: hologramPulse 3.6s ease-in-out infinite;
  }
  .hologram-frame.speaking {
    animation: hologramPulseSpeaking 0.9s ease-in-out infinite;
    filter: drop-shadow(0 0 30px var(--cyan));
  }
  .hologram-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: brightness(1.05) contrast(1.1) saturate(1.15);
  }
  .hologram-frame::before {
    content: "";
    position: absolute;
    inset: 0;
    background: repeating-linear-gradient(
      to bottom,
      rgba(79, 214, 232, 0.08) 0px,
      rgba(79, 214, 232, 0.08) 1px,
      transparent 1px,
      transparent 3px
    );
    pointer-events: none;
    animation: scanScroll 6s linear infinite;
  }
  .hologram-frame::after {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 50% 40%, transparent 40%, rgba(5, 7, 10, 0.75) 100%);
    pointer-events: none;
  }
  @keyframes hologramPulse {
    0%, 100% { filter: drop-shadow(0 0 18px var(--cyan-dim)); }
    50% { filter: drop-shadow(0 0 26px var(--cyan-dim)); }
  }
  @keyframes hologramPulseSpeaking {
    0%, 100% { filter: drop-shadow(0 0 26px var(--cyan)); }
    50% { filter: drop-shadow(0 0 40px var(--cyan)); }
  }
  @keyframes scanScroll {
    from { background-position: 0 0; }
    to { background-position: 0 40px; }
  }
  .hologram-frame.glitching .hologram-img {
    animation: imgGlitch 0.2s steps(2, jump-none) 3;
  }
  @keyframes imgGlitch {
    0%, 100% { transform: translate(0, 0); }
    33% { transform: translate(-3px, 1px); filter: brightness(1.4) hue-rotate(160deg); }
    66% { transform: translate(3px, -1px); filter: brightness(0.8) hue-rotate(120deg); }
  }
  @media (prefers-reduced-motion: reduce) {
    .hologram-frame, .hologram-frame::before, .hologram-frame.speaking { animation: none; }
  }
  .ticker {
    max-width: 460px;
    margin: 12px auto 0;
    font-size: 12px;
    color: var(--cyan);
    min-height: 16px;
  }
  .ticker.thinking { color: var(--amber); font-style: italic; }
  #waveform-wrap {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }
  #waveform {
    width: 100%;
    height: 48px;
    display: block;
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
    position: relative;
    background: rgba(12, 17, 24, 0.65);
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 16px 18px;
  }
  /* HUD corner brackets — a small accent on each panel corner, the
     recognizable "targeting frame" look of sci-fi interfaces, done with
     plain borders (no images) so it stays crisp at any size. */
  section::before,
  section::after {
    content: "";
    position: absolute;
    width: 10px;
    height: 10px;
    border-color: var(--cyan-dim);
    border-style: solid;
    border-width: 0;
    pointer-events: none;
  }
  section::before {
    top: -1px;
    left: -1px;
    border-top-width: 2px;
    border-left-width: 2px;
  }
  section::after {
    bottom: -1px;
    right: -1px;
    border-bottom-width: 2px;
    border-right-width: 2px;
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
      <div class="hologram-ring">
        <div class="hologram-frame" id="hologram-frame">
          <img src="/assets/hologram.jpg" class="hologram-img" alt="JARVIS" />
        </div>
      </div>
      <div class="side-panel right" id="side-right"></div>
    </div>
    <h1>JARVIS</h1>
    <div class="subtitle" id="statusline">connecting…</div>
    <div class="ticker" id="ticker"></div>
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
      <div id="waveform-wrap" style="display:none">
        <canvas id="waveform" width="600" height="48"></canvas>
      </div>
    </section>
    <section>
      <h2>Activity</h2>
      <div id="activity" class="activity"><div class="empty">Nothing yet.</div></div>
    </section>
    <section id="faceid-banner" style="display:none">
      <h2>Face ID / Touch ID</h2>
      <div class="row">
        <span class="empty">Not set up — anyone with this URL can view this dashboard.</span>
        <button onclick="setupFaceId()" style="background:transparent;border:1px solid var(--cyan);color:var(--cyan);padding:6px 12px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer;">Set up</button>
      </div>
    </section>
  </main>
  <footer>refreshes every 1s</footer>
<script>${WEBAUTHN_CLIENT_JS}</script>
<script>
  // Occasional idle glitch burst on the hologram image, echoing the
  // reference's data-corruption look — cosmetic only, not tied to any
  // real signal (a real fault is shown via the ticker/status line
  // instead, so this glitch never implies an actual problem).
  (function setupGlitch() {
    var frame = document.getElementById("hologram-frame");
    var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) return;
    setInterval(function () {
      if (Math.random() < 0.2) {
        frame.classList.add("glitching");
        setTimeout(function () { frame.classList.remove("glitching"); }, 250);
      }
    }, 3500);
  })();

  function renderSidePanel(el, rows) {
    el.innerHTML = rows
      .map(function (r) {
        return '<div><span class="readout-label">' + r[0] + '</span> <span class="readout-value">' + r[1] + "</span></div>";
      })
      .join("");
  }

  // Live audio waveform: connects to /dashboard/audio-ws (only meaningful
  // when the operator has enabled JARVIS_AUDIO_WAVEFORM — see README).
  // Silently does nothing if the endpoint 404s, which is the normal state
  // when the feature isn't configured.
  var waveformHistory = [];
  var WAVEFORM_BARS = 80;
  for (var wi = 0; wi < WAVEFORM_BARS; wi++) waveformHistory.push(0);

  function drawWaveform() {
    var canvas = document.getElementById("waveform");
    if (!canvas) return;
    var ctx = canvas.getContext("2d");
    var w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    var barWidth = w / WAVEFORM_BARS;
    for (var i = 0; i < waveformHistory.length; i++) {
      var level = waveformHistory[i];
      var barHeight = Math.max(2, level * h);
      ctx.fillStyle = "rgba(79, 214, 232, " + (0.4 + level * 0.6) + ")";
      ctx.fillRect(i * barWidth, (h - barHeight) / 2, barWidth * 0.7, barHeight);
    }
  }

  (function setupWaveform() {
    var proto = location.protocol === "https:" ? "wss:" : "ws:";
    var ws;
    try {
      ws = new WebSocket(proto + "//" + location.host + "/dashboard/audio-ws");
    } catch (err) {
      return;
    }
    ws.onmessage = function (event) {
      try {
        var data = JSON.parse(event.data);
        if (data.type === "level") {
          waveformHistory.push(data.level);
          if (waveformHistory.length > WAVEFORM_BARS) waveformHistory.shift();
          drawWaveform();
        }
      } catch (err) {
        // ignore malformed frames
      }
    };
    // Decay toward silence between real audio events, so the waveform
    // doesn't freeze on the last level between calls/chunks.
    setInterval(function () {
      waveformHistory.push(waveformHistory[waveformHistory.length - 1] * 0.7);
      if (waveformHistory.length > WAVEFORM_BARS) waveformHistory.shift();
      drawWaveform();
    }, 200);
  })();

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
  var lastTickerTimestamp = null;

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

      const waveformWrap = document.getElementById("waveform-wrap");
      waveformWrap.style.display = data.audioWaveformEnabled ? "block" : "none";

      const activityEl = document.getElementById("activity");
      activityEl.innerHTML = data.activity && data.activity.length
        ? data.activity.map(function (a) {
            return '<div class="activity-item"><span class="time">' + timeAgo(a.timestamp) +
              '</span><span class="msg">' + escapeHtml(a.message) + '</span></div>';
          }).join("")
        : '<div class="empty">Nothing yet.</div>';

      // Live ticker + hologram glow, driven by the most recent real
      // activity entry (JARVIS thinking/responding, a tool running) —
      // only reacts once per new entry, not on every 3s poll.
      const latest = data.activity && data.activity[0];
      const frameEl = document.getElementById("hologram-frame");
      const tickerEl = document.getElementById("ticker");
      if (latest && latest.timestamp !== lastTickerTimestamp) {
        lastTickerTimestamp = latest.timestamp;
        tickerEl.className = "ticker" + (latest.kind === "thinking" ? " thinking" : "");
        var text = latest.message.length > 90 ? latest.message.slice(0, 90) + "…" : latest.message;
        tickerEl.textContent = text;
        if (latest.kind === "speaking") {
          frameEl.classList.add("speaking");
          setTimeout(function () { frameEl.classList.remove("speaking"); }, 4000);
        }
      }

      const faceIdBanner = document.getElementById("faceid-banner");
      faceIdBanner.style.display = data.webAuthnConfigured ? "none" : "block";
    } catch (err) {
      line.textContent = "disconnected";
    }
  }

  refresh();
  setInterval(refresh, 1000);
</script>
</body>
</html>
`;
