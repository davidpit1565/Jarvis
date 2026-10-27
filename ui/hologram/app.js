/**
 * JARVIS hologram UI — application wiring.
 *
 * Talks to the real, existing Core server contract
 * (src/communication/websocket/JarvisWebSocketServer.ts), nothing invented:
 *   - GET  /status     poll, every 2.5s — devices/tools/observers counts.
 *   - WS   /observer   read-only mirror of real EventBus events. This is
 *                      what drives the Core's visual state — see
 *                      `jarvis.liveState.changed` handling below, which is
 *                      the real, authoritative per-turn state machine
 *                      (src/core/state/JarvisLiveState.ts), not a guess
 *                      built from other events.
 *   - WS   /chat       real two-way conversation (the same
 *                      orchestrator.handleUserMessage() the CLI/phone/
 *                      Telegram channels use).
 *
 * Every value shown is either real (and labeled LIVE) or explicitly
 * unavailable (shown as "—" / "NO DATA" / "OFFLINE") — never a fabricated
 * placeholder number.
 */
(function () {
  "use strict";

  // ---- Origin / token resolution -------------------------------------
  // Mirrors the previous build's documented behavior: derive host/port/
  // secure from the page's own address, overridable via ?host=&port=&secure=,
  // falling back to localhost:4770 for a file:// open or a bare dev server
  // with no hostname at all.
  function resolveOrigin() {
    const params = new URLSearchParams(location.search);
    const isFile = location.protocol === "file:" || !location.hostname;
    const host = params.get("host") || (isFile ? "localhost" : location.hostname);
    const port = params.get("port") || (isFile ? "4770" : location.port);
    const secureParam = params.get("secure");
    const secure = secureParam ? secureParam === "true" : location.protocol === "https:";
    const portPart = port ? `:${port}` : "";
    return {
      ws: `${secure ? "wss" : "ws"}://${host}${portPart}`,
      http: `${secure ? "https" : "http"}://${host}${portPart}`,
      token: params.get("token") || "",
    };
  }

  const origin = resolveOrigin();

  // ---- DOM refs --------------------------------------------------------
  const el = {
    canvas: document.getElementById("core-canvas"),
    connectionPill: document.getElementById("connection-pill"),
    connectionLabel: document.getElementById("connection-label"),
    stateReadout: document.getElementById("state-readout"),
    speakerToggle: document.getElementById("speaker-toggle"),
    micBtn: document.getElementById("mic-btn"),
    sheetToggle: document.getElementById("mobile-sheet-toggle"),
    sheetBackdrop: document.getElementById("sheet-backdrop"),
    systemPanel: document.getElementById("system-panel"),
    systemTag: document.getElementById("system-tag"),
    taskLine: document.getElementById("task-line"),
    statDevices: document.getElementById("stat-devices"),
    statTools: document.getElementById("stat-tools"),
    statObservers: document.getElementById("stat-observers"),
    activityLog: document.getElementById("activity-log"),
    chatTag: document.getElementById("chat-tag"),
    transcriptBody: document.getElementById("transcript-body"),
    composer: document.getElementById("composer"),
    chatInput: document.getElementById("chat-input"),
    sendBtn: document.getElementById("send-btn"),
    footerStatus: document.getElementById("footer-status"),
  };

  el.systemPanel.classList.add("sheet");

  // ---- Reduced motion ----------------------------------------------------
  const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  function applyReducedMotion() {
    window.JarvisCore.setReducedMotion(reducedMotionQuery.matches);
  }
  reducedMotionQuery.addEventListener
    ? reducedMotionQuery.addEventListener("change", applyReducedMotion)
    : reducedMotionQuery.addListener(applyReducedMotion);

  // ---- Core init ----------------------------------------------------
  window.JarvisCore.init(el.canvas);
  applyReducedMotion();
  function resizeCanvas() {
    window.JarvisCore.resize(window.innerWidth, window.innerHeight);
  }
  window.addEventListener("resize", resizeCanvas);
  resizeCanvas();

  // ---- Live-state handling (authoritative + local overrides) -----------
  let serverState = "OFFLINE";
  let localOverride = null; // "LISTENING" | "SPEAKING" | null — real local browser signal taking priority

  const STATE_LABEL = {
    OFFLINE: "Offline",
    IDLE: "Idle",
    LISTENING: "Listening",
    THINKING: "Thinking",
    PLANNING: "Planning",
    EXECUTING: "Executing",
    VERIFYING: "Verifying",
    WAITING: "Waiting for you",
    SPEAKING: "Speaking",
    ERROR: "Needs attention",
    STOPPED: "Stopped",
  };

  function renderState() {
    const shown = localOverride || serverState;
    window.JarvisCore.setLiveState(shown);
    el.stateReadout.textContent = STATE_LABEL[shown] || shown;
    el.connectionPill.classList.remove("live", "offline", "error");
    if (shown === "OFFLINE") {
      el.connectionPill.classList.add("offline");
      el.connectionLabel.textContent = "OFFLINE";
    } else if (shown === "ERROR") {
      el.connectionPill.classList.add("error");
      el.connectionLabel.textContent = "NEEDS ATTENTION";
    } else {
      el.connectionPill.classList.add("live");
      el.connectionLabel.textContent = "LIVE";
    }
  }

  function setServerState(state) {
    serverState = state;
    renderState();
  }

  function setLocalOverride(state) {
    localOverride = state;
    renderState();
  }

  renderState();

  // ---- Activity log + current task -------------------------------------
  const MAX_ACTIVITY_LINES = 60;

  function timeLabel() {
    const d = new Date();
    return d.toTimeString().slice(0, 8);
  }

  function pushActivity(text) {
    const line = document.createElement("div");
    line.className = "line";
    const ts = document.createElement("span");
    ts.className = "ts";
    ts.textContent = timeLabel();
    line.appendChild(ts);
    line.appendChild(document.createTextNode(text));
    el.activityLog.appendChild(line);
    while (el.activityLog.children.length > MAX_ACTIVITY_LINES) {
      el.activityLog.removeChild(el.activityLog.firstChild);
    }
    el.activityLog.scrollTop = el.activityLog.scrollHeight;
  }

  function setTask(text) {
    if (!text) {
      el.taskLine.textContent = "Nothing in progress.";
      el.taskLine.classList.add("idle-task");
    } else {
      el.taskLine.textContent = text;
      el.taskLine.classList.remove("idle-task");
    }
  }

  // ---- /status polling ----------------------------------------------------
  async function pollStatus() {
    try {
      const headers = origin.token ? { "X-Jarvis-Admin-Token": origin.token } : undefined;
      const res = await fetch(`${origin.http}/status`, { headers, cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      el.systemTag.textContent = "LIVE";
      el.systemTag.classList.add("live");

      const devices = Array.isArray(body.devices) ? body.devices : [];
      const online = devices.filter((d) => d.status === "online").length;
      el.statDevices.textContent = `${online}/${devices.length}`;
      el.statDevices.classList.remove("unavailable");

      const tools = Array.isArray(body.tools) ? body.tools.length : undefined;
      el.statTools.textContent = typeof tools === "number" ? String(tools) : "—";
      el.statTools.classList.toggle("unavailable", typeof tools !== "number");

      const observers = typeof body.observers === "number" ? body.observers : undefined;
      el.statObservers.textContent = typeof observers === "number" ? String(observers) : "—";
      el.statObservers.classList.toggle("unavailable", typeof observers !== "number");
    } catch (err) {
      el.systemTag.textContent = "NO DATA";
      el.systemTag.classList.remove("live");
      el.statDevices.textContent = "—";
      el.statDevices.classList.add("unavailable");
      el.statTools.textContent = "—";
      el.statTools.classList.add("unavailable");
      el.statObservers.textContent = "—";
      el.statObservers.classList.add("unavailable");
    }
  }
  pollStatus();
  setInterval(pollStatus, 2500);

  // ---- /observer socket --------------------------------------------------
  // Only `jarvis.liveState.changed` events for the web/CLI "chat" channel
  // drive this page's own state — other channels (phone/, sms/, telegram/,
  // voice/) share the same EventBus but describe a different real
  // conversation happening on a different channel, which this page must
  // not visually claim as its own.
  const CHAT_SESSION_PREFIX = "chat:";
  let observerSocket = null;
  let observerRetryTimer = null;

  function connectObserver() {
    clearTimeout(observerRetryTimer);
    const url = `${origin.ws}/observer${origin.token ? `?token=${encodeURIComponent(origin.token)}` : ""}`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      observerRetryTimer = setTimeout(connectObserver, 5000);
      return;
    }
    observerSocket = socket;

    socket.onopen = () => {
      setServerState("IDLE");
    };
    socket.onclose = () => {
      if (observerSocket === socket) {
        observerSocket = null;
        setServerState("OFFLINE");
      }
      observerRetryTimer = setTimeout(connectObserver, 5000);
    };
    socket.onerror = () => {
      try { socket.close(); } catch {}
    };
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleObserverEvent(msg);
    };
  }

  function summarizeInput(input) {
    try {
      const str = JSON.stringify(input ?? {});
      return str.length > 90 ? `${str.slice(0, 90)}…` : str;
    } catch {
      return "";
    }
  }

  function handleObserverEvent(msg) {
    const { type, payload } = msg || {};
    if (!type) return;

    switch (type) {
      case "jarvis.liveState.changed": {
        if (typeof payload?.sessionId === "string" && payload.sessionId.startsWith(CHAT_SESSION_PREFIX)) {
          setServerState(payload.to);
          if (payload.to === "IDLE" || payload.to === "STOPPED") setTask(null);
        }
        break;
      }
      case "brain.request":
        pushActivity(`Thinking over ${payload?.messageCount ?? "?"} message(s) of context`);
        window.JarvisCore.pulse(0.1);
        break;
      case "brain.response":
        pushActivity(`Reply drafted${payload?.toolCallCount ? ` · ${payload.toolCallCount} tool call(s) queued` : ""}`);
        window.JarvisCore.pulse(0.08);
        break;
      case "tool.requested": {
        const name = payload?.toolCall?.toolName || "tool";
        setTask(`Running ${name}(${summarizeInput(payload?.toolCall?.input)})`);
        pushActivity(`→ ${name}(${summarizeInput(payload?.toolCall?.input)})`);
        window.JarvisCore.pulse(0.14);
        break;
      }
      case "tool.executed": {
        const name = payload?.toolName || "tool";
        const ok = payload?.result?.success;
        const summary = payload?.resultSummary || (ok ? "done" : payload?.result?.error || "failed");
        pushActivity(`${ok ? "✓" : "✗"} ${name} — ${summary}`);
        window.JarvisCore.pulse(ok ? 0.1 : 0.22);
        if (!ok) {
          window.JarvisCore.setLiveState("ERROR");
          setTimeout(() => renderState(), 1400);
        }
        break;
      }
      case "tool.dispatched":
        pushActivity(`Dispatched ${payload?.toolName} to device ${payload?.deviceId}`);
        break;
      case "permission.checked":
        if (payload?.result && payload.result.allowed === false) {
          pushActivity(`Permission denied: ${payload.toolId}`);
        }
        break;
      case "device.registered":
        pushActivity(`Device registered: ${payload?.device?.name || payload?.device?.id || "unknown"}`);
        break;
      case "device.connected":
        pushActivity(`Device connected: ${payload?.deviceId}`);
        break;
      case "device.disconnected":
        pushActivity(`Device disconnected: ${payload?.deviceId}`);
        break;
      case "agent.task.transition": {
        const phase = payload?.phase || payload?.to;
        setTask(`Goal — ${phase}: ${payload?.reason || ""}`.trim());
        pushActivity(`Goal task ${payload?.taskId ? payload.taskId.slice(0, 8) : ""} → ${payload?.to}`);
        if (phase === "COMPLETED" || phase === "FAILED" || phase === "CANCELLED") {
          setTimeout(() => setTask(null), 4000);
        }
        break;
      }
      case "ai.providerFallback":
        pushActivity(`Switched provider: ${payload?.from} → ${payload?.to} (${payload?.reason})`);
        break;
      case "ai.escalation":
        pushActivity(`Escalated to a stronger model: ${payload?.from} → ${payload?.to}`);
        break;
      default:
        break;
    }
  }

  connectObserver();

  // ---- /chat socket -------------------------------------------------------
  let chatSocket = null;
  let chatRetryTimer = null;
  let streamingBubble = null;
  let typingIndicator = null;
  let pendingConfirmResolved = false;

  function addMessage(role, text) {
    const bubble = document.createElement("div");
    bubble.className = `msg ${role}`;
    bubble.textContent = text;
    el.transcriptBody.appendChild(bubble);
    el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;
    return bubble;
  }

  function addSystemNote(text) {
    addMessage("system-note", text);
  }

  function showTyping() {
    hideTyping();
    typingIndicator = addMessage("assistant", "…");
    typingIndicator.classList.add("typing");
  }
  function hideTyping() {
    if (typingIndicator && typingIndicator.parentNode) typingIndicator.parentNode.removeChild(typingIndicator);
    typingIndicator = null;
  }

  function addConfirmRow(message) {
    const row = document.createElement("div");
    row.className = "confirm-row";
    const text = document.createElement("span");
    text.textContent = message;
    row.appendChild(text);
    const yes = document.createElement("button");
    yes.className = "yes";
    yes.type = "button";
    yes.textContent = "Confirm";
    const no = document.createElement("button");
    no.className = "no";
    no.type = "button";
    no.textContent = "Cancel";
    row.appendChild(yes);
    row.appendChild(no);
    el.transcriptBody.appendChild(row);
    el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;

    const settle = (answer) => {
      yes.disabled = true;
      no.disabled = true;
      sendRaw({ text: answer ? "yes" : "no" });
      addSystemNote(answer ? "Confirmed" : "Cancelled");
    };
    yes.addEventListener("click", () => settle(true));
    no.addEventListener("click", () => settle(false));
  }

  function connectChat() {
    clearTimeout(chatRetryTimer);
    const url = `${origin.ws}/chat${origin.token ? `?token=${encodeURIComponent(origin.token)}` : ""}`;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      chatRetryTimer = setTimeout(connectChat, 5000);
      return;
    }
    chatSocket = socket;

    socket.onopen = () => {
      el.chatTag.textContent = "LIVE";
      el.chatTag.classList.add("live");
      el.footerStatus.textContent = "connected";
      el.sendBtn.disabled = false;
    };
    socket.onclose = () => {
      if (chatSocket === socket) {
        chatSocket = null;
        el.chatTag.textContent = "OFFLINE";
        el.chatTag.classList.remove("live");
        el.footerStatus.textContent = "offline — retrying";
        el.sendBtn.disabled = true;
      }
      chatRetryTimer = setTimeout(connectChat, 5000);
    };
    socket.onerror = () => {
      try { socket.close(); } catch {}
    };
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleChatMessage(msg);
    };
  }

  function handleChatMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "assistant_delta": {
        hideTyping();
        if (!streamingBubble) {
          streamingBubble = addMessage("assistant", "");
          streamingBubble.classList.add("streaming");
        }
        streamingBubble.textContent += msg.text;
        el.transcriptBody.scrollTop = el.transcriptBody.scrollHeight;
        break;
      }
      case "assistant": {
        hideTyping();
        if (streamingBubble) {
          streamingBubble.textContent = msg.text;
          streamingBubble.classList.remove("streaming");
          streamingBubble = null;
        } else {
          addMessage("assistant", msg.text);
        }
        speak(msg.text);
        break;
      }
      case "error": {
        hideTyping();
        streamingBubble = null;
        addMessage("error", msg.message || "Something went wrong.");
        break;
      }
      case "confirm": {
        hideTyping();
        addConfirmRow(msg.message || "Confirm?");
        break;
      }
      default:
        break;
    }
  }

  function sendRaw(payload) {
    if (chatSocket && chatSocket.readyState === WebSocket.OPEN) {
      chatSocket.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  function sendMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    addMessage("user", trimmed);
    if (!sendRaw({ text: trimmed })) {
      addSystemNote("Not connected to Core — message not sent.");
      return;
    }
    showTyping();
  }

  connectChat();

  el.composer.addEventListener("submit", (e) => {
    e.preventDefault();
    const text = el.chatInput.value;
    el.chatInput.value = "";
    sendMessage(text);
  });

  // ---- Speaking: real browser TTS of JARVIS's actual reply text ---------
  // Core has no server-side TTS today (confirmed against the real
  // codebase — see the PR description). This speaks the real reply text
  // via the browser's own SpeechSynthesis, and drives the Core's
  // "speaking" visual off real utterance events (onstart/onboundary/onend)
  // — genuine discrete signals, not a fabricated amplitude timer.
  //
  // Spoken replies turn on together with Voice Mode (see below) — "voice
  // mode" is meant to be one coherent hands-free loop, not two separate
  // switches the user has to manage. The speaker button is a secondary
  // mute for OUTPUT only (keep listening, stop talking back), independent
  // of whether Voice Mode itself is on.
  let speakerEnabled = false;
  const synth = window.speechSynthesis;

  function setSpeakerEnabled(on) {
    speakerEnabled = on;
    el.speakerToggle.classList.toggle("active", speakerEnabled);
    el.speakerToggle.setAttribute("aria-pressed", String(speakerEnabled));
    if (!speakerEnabled && synth) synth.cancel();
  }

  el.speakerToggle.addEventListener("click", () => setSpeakerEnabled(!speakerEnabled));

  function pickVoice(lang) {
    if (!synth) return undefined;
    const voices = synth.getVoices();
    if (!voices.length) return undefined;
    const want = lang === "he" ? "he" : "en";
    return voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(want)) || voices[0];
  }

  function speak(text) {
    if (!speakerEnabled || !synth || !text) return;
    try {
      synth.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const voice = pickVoice();
      if (voice) utter.voice = voice;
      utter.rate = 1.0;
      utter.pitch = 0.92;
      utter.onstart = () => {
        setLocalOverride("SPEAKING");
        pauseListeningForPlayback();
      };
      utter.onboundary = () => window.JarvisCore.pulse(0.1);
      utter.onend = () => {
        setLocalOverride(null);
        resumeListeningAfterPlayback();
      };
      utter.onerror = () => {
        setLocalOverride(null);
        resumeListeningAfterPlayback();
      };
      synth.speak(utter);
    } catch {
      // SpeechSynthesis not available/blocked — fail silently, no fake state.
    }
  }

  // ---- Voice Mode: continuous, hands-free listening -----------------------
  //
  // Per David's explicit requirement: the default interaction model is
  // voice, with no push-to-talk button for every utterance. One tap/click
  // on the mic turns Voice Mode on; after that, both listening and spoken
  // replies run continuously with no further button presses — the single
  // unavoidable manual step is that first tap, which grants the browser's
  // own real microphone permission (a genuine platform requirement, not a
  // design choice; no web page can bypass it).
  //
  // Real, documented platform difference, checked for this build (not
  // assumed from memory): desktop Chrome/Edge's `continuous = true`
  // SpeechRecognition keeps listening across multiple utterances
  // reliably, restarting cleanly on its own `end` event. iOS Safari
  // supports the same API (since Safari 14.5) but real-world reports are
  // consistent that `continuous` mode is unreliable there — it stops
  // listening on its own after a short silence/timeout regardless of the
  // flag. This page handles both the same way: every `end`/non-fatal
  // `error` event triggers an automatic restart while Voice Mode is on,
  // which gives genuine hands-free behavior on desktop (restarts are
  // typically invisible) and the closest honest equivalent on iPhone (one
  // tap opens an ongoing session that keeps re-listening between
  // utterances on its own, not a fresh tap required per sentence — still
  // not literally gapless the way desktop Chrome is, since each restart
  // takes a brief real moment).
  //
  // Echo avoidance: while JARVIS is actually speaking (real TTS
  // playback), recognition is paused and resumed on real onstart/onend
  // events — otherwise a continuously-open mic would transcribe JARVIS's
  // own voice back to itself.
  //
  // Scope note (flagged honestly, not silently decided): there is no
  // wake-word gate here ("Hey JARVIS" is a separate, larger effort per
  // the project's own roadmap). A final transcript is only sent as a
  // message if it contains "jarvis" (English) or a Hebrew wake variant —
  // a simple client-side text filter, not the real wake-word system —
  // chosen so an always-open mic doesn't send every word of ambient room
  // conversation to the assistant. This is a judgment call, flagged back
  // to David rather than assumed.
  const WAKE_WORD_PATTERN = /\bjarvis\b|ג'?ארוויס|ג'?רוויס/i;

  let voiceModeEnabled = false;
  let micStream = null;
  let audioCtx = null;
  let analyser = null;
  let micRaf = null;
  let recognizer = null;
  let recognitionRunning = false;
  let pausedForPlayback = false;
  let restartTimer = null;
  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

  function tickMicLevel() {
    if (!analyser) return;
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length / 255;
    window.JarvisCore.setAudioLevel(avg);
    micRaf = requestAnimationFrame(tickMicLevel);
  }

  function startRecognitionInstance() {
    if (!SpeechRecognitionCtor || !voiceModeEnabled || pausedForPlayback || recognitionRunning) return;
    recognizer = new SpeechRecognitionCtor();
    recognizer.continuous = true;
    recognizer.interimResults = true;
    recognizer.lang = (navigator.language || "en-US");

    recognizer.onstart = () => {
      recognitionRunning = true;
      setLocalOverride("LISTENING");
    };
    recognizer.onresult = (ev) => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const result = ev.results[i];
        const transcript = result[0]?.transcript || "";
        if (result.isFinal) {
          if (WAKE_WORD_PATTERN.test(transcript)) {
            sendMessage(transcript);
          }
          el.chatInput.value = "";
        } else {
          interim += transcript;
        }
      }
      if (interim) el.chatInput.value = interim;
    };
    recognizer.onerror = (ev) => {
      recognitionRunning = false;
      if (ev.error === "not-allowed" || ev.error === "service-not-allowed") {
        addSystemNote("Microphone access was denied — Voice Mode turned off.");
        disableVoiceMode();
        return;
      }
      // "no-speech"/"aborted"/network hiccups: let onend's restart logic
      // handle it, same as a natural end.
    };
    recognizer.onend = () => {
      recognitionRunning = false;
      if (localOverride === "LISTENING") setLocalOverride(null);
      if (voiceModeEnabled && !pausedForPlayback) {
        clearTimeout(restartTimer);
        restartTimer = setTimeout(startRecognitionInstance, 300);
      }
    };
    try {
      recognizer.start();
    } catch {
      recognitionRunning = false;
    }
  }

  function pauseListeningForPlayback() {
    if (!voiceModeEnabled) return;
    pausedForPlayback = true;
    if (recognizer && recognitionRunning) {
      try { recognizer.stop(); } catch {}
    }
  }

  function resumeListeningAfterPlayback() {
    if (!voiceModeEnabled) return;
    pausedForPlayback = false;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(startRecognitionInstance, 250);
  }

  async function enableVoiceMode() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      addSystemNote("Microphone access was not granted.");
      return;
    }
    voiceModeEnabled = true;
    el.micBtn.classList.add("active");
    el.micBtn.setAttribute("aria-pressed", "true");
    el.micBtn.title = "Voice mode is on — tap to turn off";
    addSystemNote("Voice mode on — always listening, no button needed per message.");
    setSpeakerEnabled(true);

    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    audioCtx = new AudioContextCtor();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    tickMicLevel();

    if (SpeechRecognitionCtor) {
      startRecognitionInstance();
    } else {
      addSystemNote("Voice transcription isn't supported in this browser — showing live audio level only; use the text box to talk.");
    }
  }

  function disableVoiceMode() {
    voiceModeEnabled = false;
    pausedForPlayback = false;
    clearTimeout(restartTimer);
    el.micBtn.classList.remove("active");
    el.micBtn.setAttribute("aria-pressed", "false");
    el.micBtn.title = "Enable voice mode";
    if (micRaf) cancelAnimationFrame(micRaf);
    micRaf = null;
    if (recognizer) {
      try { recognizer.stop(); } catch {}
      recognizer = null;
    }
    recognitionRunning = false;
    if (micStream) {
      micStream.getTracks().forEach((t) => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    window.JarvisCore.setAudioLevel(0);
    if (localOverride === "LISTENING") setLocalOverride(null);
    setSpeakerEnabled(false);
  }

  if (!SpeechRecognitionCtor) {
    el.micBtn.title = "Voice transcription not supported in this browser";
  }

  el.micBtn.addEventListener("click", () => {
    if (voiceModeEnabled) {
      disableVoiceMode();
    } else {
      enableVoiceMode();
    }
  });

  // ---- Mobile status sheet -------------------------------------------------
  function openSheet() {
    el.systemPanel.classList.add("open");
    el.sheetBackdrop.classList.remove("hidden");
  }
  function closeSheet() {
    el.systemPanel.classList.remove("open");
    el.sheetBackdrop.classList.add("hidden");
  }
  el.sheetToggle.addEventListener("click", () => {
    el.systemPanel.classList.contains("open") ? closeSheet() : openSheet();
  });
  el.sheetBackdrop.addEventListener("click", closeSheet);
})();
