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
  /** Twilio <Say> voice name (e.g. "Polly.Matthew"); unset uses the gateway's own default. */
  twilioVoice?: string;
  /**
   * Twilio <Say> voice for Hebrew replies (e.g. "Google.he-IL-Standard-D") —
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
   * SSML `<prosody pitch>`/`<prosody rate>` applied to every spoken line,
   * for JARVIS's deliberately deep, machine-sounding phone voice (not a
   * human, not "cute") — see TwilioVoiceGateway's DEFAULT_VOICE comment.
   * Unset uses the gateway's own defaults.
   */
  twilioVoicePitch?: string;
  twilioVoiceRate?: string;
  /**
   * Bot token (from @BotFather) and webhook secret required together to
   * enable the optional Telegram gateway — a scoped alternative to "give
   * JARVIS access to all my Telegram messages": the user adds this
   * specific bot to specific chats, and JARVIS only ever sees messages
   * sent to it there, never anything else on the account.
   */
  telegramBotToken?: string;
  /** Verifies incoming webhook requests actually came from Telegram (the `X-Telegram-Bot-Api-Secret-Token` header Telegram echoes back, set via setWebhook's own `secret_token` field). */
  telegramWebhookSecret?: string;
  /** Numeric Telegram chat IDs allowed to talk to the bot; empty/unset means any chat that finds/adds the bot can. */
  telegramAllowedChatIds?: string[];
  /**
   * The owner's own Telegram chat ID — required for NOTIFY_USER to have
   * somewhere to push a proactive message to. Distinct from
   * telegramAllowedChatIds (which chats may talk *to* JARVIS): this is
   * specifically where JARVIS talks *first*, unprompted.
   */
  telegramOwnerChatId?: string;
  /**
   * Both required together to enable GET_WEATHER — a real, free (Open-Meteo,
   * no API key) current-weather lookup for one fixed location, since a
   * personal assistant only ever needs to know the weather where its one
   * user actually is.
   */
  weatherLatitude?: number;
  weatherLongitude?: number;
  /** Enables GET_NEWS — free RSS headlines from this one configured feed. Unset means the tool doesn't exist. */
  newsRssUrl?: string;
  /**
   * Both required together to enable the weekly usage/cost digest, pushed
   * via NOTIFY_USER's own Telegram delivery (so it also needs
   * telegramGateway + telegramOwnerChatId configured). Day 0=Sunday..6=Saturday.
   */
  weeklyDigestDayOfWeek?: number;
  weeklyDigestTime?: string;
  /**
   * Hours of no interaction (any channel) before JARVIS sends a wellness
   * check-in via NOTIFY_USER's own Telegram delivery — also needs
   * telegramGateway + telegramOwnerChatId configured. Unset disables the
   * feature entirely.
   */
  checkinAfterHours?: number;
  /**
   * "HH:MM" local time (in `timezone`) JARVIS sends a daily morning
   * briefing — weather + today's calendar + due/overdue reminders — via
   * NOTIFY_USER's own Telegram delivery (also needs telegramGateway +
   * telegramOwnerChatId configured). Unset disables the feature entirely.
   */
  morningBriefingTime?: string;
  /**
   * Optional all-time estimated-cost threshold (USD). When set, JARVIS
   * warns (console + activity log) once cumulative estimated spend
   * crosses 75%, 90%, and 100% of it — each stage fires once, not on
   * every call past it. All-time, not daily/monthly, since
   * TokenUsageStore only tracks a running total; a real budget period
   * would need time-windowed queries this doesn't have yet.
   */
  costAlertThresholdUsd?: number;
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
  /**
   * Overrides the Anthropic API base URL — explicit opt-in only, for
   * pointing JARVIS's brain at a local Anthropic-compatible model gateway
   * instead of Anthropic's own metered API, for cost reasons. Unset (the
   * default) means the real Anthropic API, always; this is never picked
   * up from the ambient ANTHROPIC_BASE_URL environment variable that other
   * tools on the same machine might set, only from this JARVIS-specific
   * variable, so JARVIS never silently starts talking to some unrelated
   * local proxy just because it happened to be running.
   */
  anthropicBaseUrl?: string;
  /**
   * A cheaper/different model to retry against, once, when the primary
   * model call fails with a 429/503/529 even after the SDK's own
   * automatic retries — a degraded reply beats no reply during a
   * provider outage or rate-limit spike. Opt-in only; unset means never
   * fall back.
   */
  fallbackModel?: string;
  /**
   * The public base URL this server is reachable at — used for the Google
   * Calendar OAuth redirect URI. Distinct from twilioPublicBaseUrl: a
   * user might want calendar integration without the phone gateway (or
   * vice versa), so this isn't implied by/tied to Twilio's own config,
   * even though in practice they're often the same URL.
   */
  publicBaseUrl?: string;
  /** Google OAuth client credentials — both required together to enable Calendar integration. */
  googleClientId?: string;
  googleClientSecret?: string;
  /** Path to the SQLite database storing the linked Google account's OAuth tokens. */
  calendarTokenDbPath: string;
  /** Spotify OAuth client credentials — both required together to enable Spotify integration. */
  spotifyClientId?: string;
  spotifyClientSecret?: string;
  /** Path to the SQLite database storing the linked Spotify account's OAuth tokens. */
  spotifyTokenDbPath: string;
  /** Both required together to enable the video studio integration (reels list, publish, Instagram stats). */
  studioBaseUrl?: string;
  studioSecret?: string;
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
  const twilioVoicePitch = process.env.TWILIO_VOICE_PITCH?.trim() || undefined;
  const twilioVoiceRate = process.env.TWILIO_VOICE_RATE?.trim() || undefined;
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
  const anthropicBaseUrl = process.env.JARVIS_ANTHROPIC_BASE_URL?.trim() || undefined;
  const fallbackModel = process.env.JARVIS_FALLBACK_MODEL?.trim() || undefined;
  const publicBaseUrl = process.env.JARVIS_PUBLIC_BASE_URL?.trim() || undefined;
  const googleClientId = process.env.GOOGLE_CLIENT_ID?.trim() || undefined;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim() || undefined;
  const calendarTokenDbPath = process.env.JARVIS_CALENDAR_TOKEN_DB_PATH ?? "./data/jarvis-calendar-tokens.sqlite";

  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new ConfigError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together (or neither) to enable Calendar integration");
  }
  if (googleClientId && googleClientSecret && !publicBaseUrl) {
    throw new ConfigError(
      "JARVIS_PUBLIC_BASE_URL is required once Calendar integration is configured (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET) — " +
        "Google needs a real, fixed redirect URI for the OAuth flow, the same way TWILIO_PUBLIC_BASE_URL is required for Twilio."
    );
  }
  if (googleClientId && googleClientSecret && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once Calendar integration is configured — GET /calendar/oauth/start starts " +
        "an OAuth flow linking a real Google account and must not be triggerable by an unauthenticated request."
    );
  }

  const spotifyClientId = process.env.SPOTIFY_CLIENT_ID?.trim() || undefined;
  const spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET?.trim() || undefined;
  const spotifyTokenDbPath = process.env.JARVIS_SPOTIFY_TOKEN_DB_PATH ?? "./data/jarvis-spotify-tokens.sqlite";

  if (Boolean(spotifyClientId) !== Boolean(spotifyClientSecret)) {
    throw new ConfigError("SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET must be set together (or neither) to enable Spotify integration");
  }
  if (spotifyClientId && spotifyClientSecret && !publicBaseUrl) {
    throw new ConfigError(
      "JARVIS_PUBLIC_BASE_URL is required once Spotify integration is configured (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET) — " +
        "Spotify needs a real, fixed redirect URI for the OAuth flow."
    );
  }
  if (spotifyClientId && spotifyClientSecret && !adminToken) {
    throw new ConfigError(
      "JARVIS_ADMIN_TOKEN is required once Spotify integration is configured — GET /spotify/oauth/start starts " +
        "an OAuth flow linking a real Spotify account and must not be triggerable by an unauthenticated request."
    );
  }

  const studioBaseUrl = process.env.JARVIS_STUDIO_BASE_URL?.trim() || undefined;
  const studioSecret = process.env.JARVIS_STUDIO_SECRET?.trim() || undefined;
  if (Boolean(studioBaseUrl) !== Boolean(studioSecret)) {
    throw new ConfigError(
      "JARVIS_STUDIO_BASE_URL and JARVIS_STUDIO_SECRET must be set together (or neither) to enable the video studio integration"
    );
  }

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

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
  const telegramWebhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim() || undefined;
  const telegramAllowedChatIds = process.env.TELEGRAM_ALLOWED_CHAT_IDS?.split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const telegramOwnerChatId = process.env.TELEGRAM_OWNER_CHAT_ID?.trim() || undefined;

  const telegramFieldsSet = [telegramBotToken, telegramWebhookSecret].filter(Boolean).length;
  if (telegramFieldsSet > 0 && telegramFieldsSet < 2) {
    throw new ConfigError(
      "TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET must both be set together (or neither) to enable the " +
        "Telegram gateway — the secret is what proves an incoming webhook request actually came from Telegram."
    );
  }

  const weatherLatitudeRaw = process.env.JARVIS_WEATHER_LATITUDE?.trim();
  const weatherLongitudeRaw = process.env.JARVIS_WEATHER_LONGITUDE?.trim();
  const weatherLatitude = weatherLatitudeRaw ? Number(weatherLatitudeRaw) : undefined;
  const weatherLongitude = weatherLongitudeRaw ? Number(weatherLongitudeRaw) : undefined;

  if ((weatherLatitudeRaw && Number.isNaN(weatherLatitude)) || (weatherLongitudeRaw && Number.isNaN(weatherLongitude))) {
    throw new ConfigError("JARVIS_WEATHER_LATITUDE and JARVIS_WEATHER_LONGITUDE must be valid numbers");
  }
  if (
    (weatherLatitude !== undefined && (weatherLatitude < -90 || weatherLatitude > 90)) ||
    (weatherLongitude !== undefined && (weatherLongitude < -180 || weatherLongitude > 180))
  ) {
    throw new ConfigError(
      "JARVIS_WEATHER_LATITUDE must be between -90 and 90, and JARVIS_WEATHER_LONGITUDE between -180 and 180"
    );
  }

  const weatherFieldsSet = [weatherLatitude, weatherLongitude].filter((v) => v !== undefined).length;
  if (weatherFieldsSet > 0 && weatherFieldsSet < 2) {
    throw new ConfigError(
      "JARVIS_WEATHER_LATITUDE and JARVIS_WEATHER_LONGITUDE must both be set together (or neither) to enable weather lookups"
    );
  }

  const newsRssUrl = process.env.JARVIS_NEWS_RSS_URL?.trim() || undefined;

  const weeklyDigestDayRaw = process.env.JARVIS_WEEKLY_DIGEST_DAY?.trim();
  const weeklyDigestTime = process.env.JARVIS_WEEKLY_DIGEST_TIME?.trim() || undefined;
  const weeklyDigestDayOfWeek = weeklyDigestDayRaw ? Number(weeklyDigestDayRaw) : undefined;

  if (
    weeklyDigestDayRaw &&
    (Number.isNaN(weeklyDigestDayOfWeek) || weeklyDigestDayOfWeek! < 0 || weeklyDigestDayOfWeek! > 6)
  ) {
    throw new ConfigError("JARVIS_WEEKLY_DIGEST_DAY must be an integer from 0 (Sunday) to 6 (Saturday)");
  }
  if (weeklyDigestTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(weeklyDigestTime)) {
    throw new ConfigError("JARVIS_WEEKLY_DIGEST_TIME must be in HH:MM 24-hour format");
  }

  const weeklyDigestFieldsSet = [weeklyDigestDayOfWeek, weeklyDigestTime].filter((v) => v !== undefined).length;
  if (weeklyDigestFieldsSet > 0 && weeklyDigestFieldsSet < 2) {
    throw new ConfigError(
      "JARVIS_WEEKLY_DIGEST_DAY and JARVIS_WEEKLY_DIGEST_TIME must both be set together (or neither)"
    );
  }

  const checkinAfterHoursRaw = process.env.JARVIS_CHECKIN_AFTER_HOURS?.trim();
  const checkinAfterHours = checkinAfterHoursRaw ? Number(checkinAfterHoursRaw) : undefined;
  if (checkinAfterHoursRaw && (Number.isNaN(checkinAfterHours) || checkinAfterHours! <= 0)) {
    throw new ConfigError("JARVIS_CHECKIN_AFTER_HOURS must be a positive number");
  }

  const morningBriefingTime = process.env.JARVIS_MORNING_BRIEFING_TIME?.trim() || undefined;
  if (morningBriefingTime && !/^([01]\d|2[0-3]):[0-5]\d$/.test(morningBriefingTime)) {
    throw new ConfigError("JARVIS_MORNING_BRIEFING_TIME must be in HH:MM 24-hour format");
  }

  const costAlertThresholdRaw = process.env.JARVIS_COST_ALERT_THRESHOLD_USD?.trim();
  const costAlertThresholdUsd = costAlertThresholdRaw ? Number(costAlertThresholdRaw) : undefined;
  if (costAlertThresholdRaw && (Number.isNaN(costAlertThresholdUsd) || costAlertThresholdUsd! <= 0)) {
    throw new ConfigError("JARVIS_COST_ALERT_THRESHOLD_USD must be a positive number");
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
    twilioVoicePitch,
    twilioVoiceRate,
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
    anthropicBaseUrl,
    fallbackModel,
    publicBaseUrl,
    googleClientId,
    googleClientSecret,
    calendarTokenDbPath,
    spotifyClientId,
    spotifyClientSecret,
    spotifyTokenDbPath,
    studioBaseUrl,
    studioSecret,
    telegramBotToken,
    telegramWebhookSecret,
    telegramAllowedChatIds,
    telegramOwnerChatId,
    weatherLatitude,
    weatherLongitude,
    newsRssUrl,
    weeklyDigestDayOfWeek,
    weeklyDigestTime,
    checkinAfterHours,
    morningBriefingTime,
    costAlertThresholdUsd,
  };
}

export { ConfigError };
