export interface JarvisConfig {
  anthropicApiKey: string;
  port: number;
  memoryDbPath: string;
  /** Path to the SQLite database storing registered Face ID/Touch ID (WebAuthn) credentials. */
  webauthnDbPath: string;
  /** Both must be set together to enable the optional Twilio phone gateway. */
  twilioAuthToken?: string;
  /**
   * The exact public base URL Twilio is configured to call (e.g. an ngrok
   * URL). Required for signature verification: a reverse-proxied request's
   * `req.url` as seen by this process reflects the internal address, not
   * the public one Twilio actually signed.
   */
  twilioPublicBaseUrl?: string;
  /** E.164 numbers allowed to call JARVIS; empty/unset means any caller is let through. */
  twilioAllowedCallers?: string[];
  /** Twilio <Say> voice name (e.g. "Polly.Matthew-Neural"); unset uses the gateway's own default. */
  twilioVoice?: string;
  /**
   * Twilio <Say> voice for Hebrew replies (e.g. "Google.he-IL-Wavenet-D") —
   * separate from twilioVoice because Amazon Polly has no Hebrew voice at
   * all, so Hebrew always goes through Twilio's Google TTS integration.
   * Unset uses the gateway's own default.
   */
  twilioVoiceHebrew?: string;
  /**
   * Language Twilio's <Gather> should recognize speech in. Unset uses the
   * gateway's own default ("multi" — real automatic Hebrew/English
   * detection via Twilio's deepgram_nova-3 speech model). Set this to a
   * single BCP-47 code (e.g. "he-IL" or "en-US") only if that model isn't
   * available on the Twilio account this runs on.
   */
  twilioGatherLanguage?: string;
  /**
   * Shared secret required on POST /pairing/approve. Mandatory once the
   * phone gateway is configured, since that makes this same server
   * reachable from the public internet — without it, the pairing code
   * alone (handed back to whoever requested it) is enough to self-approve
   * a fake device. Optional for purely local development.
   */
  adminToken?: string;
  /**
   * Enables Anthropic's own server-side web_search tool — real internet
   * search billed through the same Anthropic account, no separate vendor.
   * Off by default: it changes what JARVIS can see and costs extra per
   * search, so it's an explicit opt-in.
   */
  webSearchEnabled: boolean;
  /** Caps how many searches Claude may run in a single turn. */
  webSearchMaxUses: number;
  /**
   * Enables live phone-call audio waveform visualization on the
   * dashboard, via Twilio Media Streams. Only meaningful when the phone
   * gateway is also configured. Off by default: Twilio bills Media
   * Streams at ~$0.004/min on top of normal call minutes — a real,
   * if small, extra cost, so this is never silently turned on.
   */
  audioWaveformEnabled: boolean;
}

class ConfigError extends Error {}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(`Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Loads and validates configuration from environment variables.
 * Never logs the actual values of secrets.
 */
export function loadConfig(): JarvisConfig {
  const anthropicApiKey = requireEnv("ANTHROPIC_API_KEY");
  const port = Number(process.env.JARVIS_PORT ?? "4770");
  const memoryDbPath = process.env.JARVIS_MEMORY_DB_PATH ?? "./data/jarvis-memory.sqlite";
  const webauthnDbPath = process.env.JARVIS_WEBAUTHN_DB_PATH ?? "./data/jarvis-webauthn.sqlite";

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`Invalid JARVIS_PORT: must be an integer between 1 and 65535`);
  }

  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim() || undefined;
  const twilioPublicBaseUrl = process.env.TWILIO_PUBLIC_BASE_URL?.trim() || undefined;

  if (Boolean(twilioAuthToken) !== Boolean(twilioPublicBaseUrl)) {
    throw new ConfigError(
      "TWILIO_AUTH_TOKEN and TWILIO_PUBLIC_BASE_URL must be set together (or neither) to enable the phone gateway"
    );
  }

  const twilioAllowedCallers = process.env.TWILIO_ALLOWED_CALLERS?.split(",")
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
  const twilioVoice = process.env.TWILIO_VOICE?.trim() || undefined;
  const twilioVoiceHebrew = process.env.TWILIO_VOICE_HEBREW?.trim() || undefined;
  const twilioGatherLanguage = process.env.TWILIO_GATHER_LANGUAGE?.trim() || undefined;
  const adminToken = process.env.JARVIS_ADMIN_TOKEN?.trim() || undefined;
  const webSearchEnabled = process.env.JARVIS_WEB_SEARCH?.trim().toLowerCase() === "true";
  const webSearchMaxUses = Number(process.env.JARVIS_WEB_SEARCH_MAX_USES ?? "5");

  if (!Number.isInteger(webSearchMaxUses) || webSearchMaxUses <= 0) {
    throw new ConfigError("Invalid JARVIS_WEB_SEARCH_MAX_USES: must be a positive integer");
  }

  const audioWaveformEnabled = process.env.JARVIS_AUDIO_WAVEFORM?.trim().toLowerCase() === "true";

  if (twilioAuthToken && twilioPublicBaseUrl && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once the phone gateway is configured (TWILIO_AUTH_TOKEN/TWILIO_PUBLIC_BASE_URL) — " +
        "this server becomes reachable from the public internet, and POST /pairing/approve needs a secret independent of " +
        "the pairing code itself to stay safe from self-approved fake devices. Set JARVIS_ADMIN_TOKEN to any long random value."
    );
  }

  return {
    anthropicApiKey,
    port,
    memoryDbPath,
    webauthnDbPath,
    twilioAuthToken,
    twilioPublicBaseUrl,
    twilioAllowedCallers,
    twilioVoice,
    twilioVoiceHebrew,
    twilioGatherLanguage,
    adminToken,
    webSearchEnabled,
    webSearchMaxUses,
    audioWaveformEnabled,
  };
}

export { ConfigError };
