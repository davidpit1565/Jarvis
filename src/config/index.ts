export interface JarvisConfig {
  anthropicApiKey: string;
  port: number;
  memoryDbPath: string;
  /** Path to the SQLite database storing registered Face ID/Touch ID (WebAuthn) credentials. */
  webauthnDbPath: string;
  /** Path to the SQLite database storing reminders/tasks. */
  remindersDbPath: string;
  /**
   * Path to the SQLite database backing the dashboard's activity log, so
   * recent activity survives a restart/redeploy instead of resetting to
   * "Nothing yet." every time.
   */
  activityLogDbPath: string;
  /** Path to the SQLite database storing the full conversation transcript, for SEARCH_CONVERSATION_HISTORY. */
  conversationHistoryDbPath: string;
  /** Path to the SQLite database storing paired-device credentials, so devices don't need to re-pair after every restart. */
  pairingDbPath: string;
  /** Path to the SQLite database storing device identity/role, so a device doesn't lose its role after every restart. */
  deviceRegistryDbPath: string;
  /** Path to the SQLite database storing the structured tool-execution audit trail. */
  toolAuditLogDbPath: string;
  /** Path to the SQLite database storing per-call token usage, for real cost visibility. */
  tokenUsageDbPath: string;
  /**
   * IANA timezone (e.g. "Asia/Jerusalem") used to tell Claude the user's
   * local time every turn, so relative times ("tomorrow at 9am") resolve
   * correctly. Defaults to UTC — set this to your actual timezone.
   */
  timezone: string;
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
  /**
   * Twilio Account SID, the Twilio phone number to call FROM, and the
   * owner's own phone number to call — all three required together to
   * enable outbound calls (currently: scheduled wake-up calls). Distinct
   * from the inbound phone gateway's config above: a Twilio account can
   * receive calls without ever placing one, so this is opt-in on top of
   * that, not implied by it.
   */
  twilioAccountSid?: string;
  twilioFromNumber?: string;
  ownerPhoneNumber?: string;
  /** Path to the SQLite database storing recurring wake-up/scheduled-call times. */
  wakeUpCallDbPath: string;
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
   * Enables Anthropic's own server-side web_fetch tool — lets Claude
   * actually read a specific URL's content, not just a search snippet.
   * Same account/billing as web_search. Off by default, same reasoning.
   */
  webFetchEnabled: boolean;
  /** Caps how many URL fetches Claude may run in a single turn. */
  webFetchMaxUses: number;
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
  const remindersDbPath = process.env.JARVIS_REMINDERS_DB_PATH ?? "./data/jarvis-reminders.sqlite";
  const activityLogDbPath = process.env.JARVIS_ACTIVITY_LOG_DB_PATH ?? "./data/jarvis-activity.sqlite";
  const conversationHistoryDbPath =
    process.env.JARVIS_CONVERSATION_HISTORY_DB_PATH ?? "./data/jarvis-conversation-history.sqlite";
  const pairingDbPath = process.env.JARVIS_PAIRING_DB_PATH ?? "./data/jarvis-pairing.sqlite";
  const deviceRegistryDbPath = process.env.JARVIS_DEVICE_REGISTRY_DB_PATH ?? "./data/jarvis-devices.sqlite";
  const toolAuditLogDbPath = process.env.JARVIS_TOOL_AUDIT_LOG_DB_PATH ?? "./data/jarvis-tool-audit.sqlite";
  const tokenUsageDbPath = process.env.JARVIS_TOKEN_USAGE_DB_PATH ?? "./data/jarvis-token-usage.sqlite";

  const timezone = process.env.JARVIS_TIMEZONE?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new ConfigError(`Invalid JARVIS_TIMEZONE: "${timezone}" is not a recognized IANA timezone name`);
  }

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

  const webFetchEnabled = process.env.JARVIS_WEB_FETCH?.trim().toLowerCase() === "true";
  const webFetchMaxUses = Number(process.env.JARVIS_WEB_FETCH_MAX_USES ?? "5");

  if (!Number.isInteger(webFetchMaxUses) || webFetchMaxUses <= 0) {
    throw new ConfigError("Invalid JARVIS_WEB_FETCH_MAX_USES: must be a positive integer");
  }

  const audioWaveformEnabled = process.env.JARVIS_AUDIO_WAVEFORM?.trim().toLowerCase() === "true";

  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim() || undefined;
  const twilioFromNumber = process.env.TWILIO_FROM_NUMBER?.trim() || undefined;
  const ownerPhoneNumber = process.env.JARVIS_OWNER_PHONE_NUMBER?.trim() || undefined;
  const wakeUpCallDbPath = process.env.JARVIS_WAKEUP_CALL_DB_PATH ?? "./data/jarvis-wakeup-calls.sqlite";

  const outboundCallFieldsSet = [twilioAccountSid, twilioFromNumber, ownerPhoneNumber].filter(Boolean).length;
  if (outboundCallFieldsSet > 0 && outboundCallFieldsSet < 3) {
    throw new ConfigError(
      "TWILIO_ACCOUNT_SID, TWILIO_FROM_NUMBER, and JARVIS_OWNER_PHONE_NUMBER must all be set together " +
        "(or none of them) to enable outbound calls (e.g. scheduled wake-up calls)"
    );
  }

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
    remindersDbPath,
    activityLogDbPath,
    conversationHistoryDbPath,
    pairingDbPath,
    deviceRegistryDbPath,
    toolAuditLogDbPath,
    tokenUsageDbPath,
    timezone,
    twilioAuthToken,
    twilioPublicBaseUrl,
    twilioAllowedCallers,
    twilioVoice,
    twilioVoiceHebrew,
    twilioGatherLanguage,
    twilioAccountSid,
    twilioFromNumber,
    ownerPhoneNumber,
    wakeUpCallDbPath,
    adminToken,
    webSearchEnabled,
    webSearchMaxUses,
    webFetchEnabled,
    webFetchMaxUses,
    audioWaveformEnabled,
  };
}

export { ConfigError };
