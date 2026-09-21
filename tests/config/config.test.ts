import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, ConfigError, redactConfigForDisplay } from "@/config";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "JARVIS_BRAIN_PROVIDER",
  "GROQ_API_KEY",
  "JARVIS_GROQ_MODEL",
  "JARVIS_PORT",
  "JARVIS_MEMORY_DB_PATH",
  "TWILIO_AUTH_TOKEN",
  "TWILIO_PUBLIC_BASE_URL",
  "TWILIO_ALLOWED_CALLERS",
  "TWILIO_VOICE",
  "TWILIO_VOICE_HEBREW",
  "TWILIO_VOICE_PITCH",
  "TWILIO_VOICE_RATE",
  "TWILIO_GATHER_LANGUAGE",
  "JARVIS_ADMIN_TOKEN",
  "JARVIS_WEB_SEARCH",
  "JARVIS_WEB_SEARCH_MAX_USES",
  "JARVIS_WEB_FETCH",
  "JARVIS_WEB_FETCH_MAX_USES",
  "JARVIS_AUDIO_WAVEFORM",
  "JARVIS_TIMEZONE",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_FROM_NUMBER",
  "JARVIS_OWNER_PHONE_NUMBER",
  "JARVIS_MAX_OUTBOUND_CALLS_PER_DAY",
  "JARVIS_WAKEUP_CALL_DB_PATH",
  "JARVIS_ANTHROPIC_BASE_URL",
  "JARVIS_FALLBACK_MODEL",
  "JARVIS_PUBLIC_BASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JARVIS_CALENDAR_TOKEN_DB_PATH",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
  "JARVIS_SPOTIFY_TOKEN_DB_PATH",
  "JARVIS_STUDIO_BASE_URL",
  "JARVIS_STUDIO_SECRET",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_OWNER_CHAT_ID",
  "JARVIS_WEATHER_LATITUDE",
  "JARVIS_WEATHER_LONGITUDE",
  "JARVIS_NEWS_RSS_URL",
  "JARVIS_WEEKLY_DIGEST_DAY",
  "JARVIS_WEEKLY_DIGEST_TIME",
  "JARVIS_CHECKIN_AFTER_HOURS",
  "JARVIS_MORNING_BRIEFING_TIME",
  "JARVIS_COST_ALERT_THRESHOLD_USD",
  "AI_FREE_FIRST",
  "AI_FALLBACK_PROVIDER",
  "MAX_DAILY_COST_USD",
  "MAX_MONTHLY_COST_USD",
  "ZERO_COST_MODE",
  "AI_CIRCUIT_BREAKER_THRESHOLD",
  "AI_CIRCUIT_BREAKER_COOLDOWN_MS",
  "JARVIS_AI_COST_DB_PATH",
  "JARVIS_COMMITMENTS_DB_PATH",
  "JARVIS_STALE_COMMITMENT_DAYS",
  "JARVIS_QUIET_HOURS_START",
  "JARVIS_QUIET_HOURS_END",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("loadConfig", () => {
  test("throws when ANTHROPIC_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults brainProvider to anthropic", () => {
    const config = loadConfig();
    expect(config.brainProvider).toBe("anthropic");
  });

  test("rejects an invalid JARVIS_BRAIN_PROVIDER", () => {
    process.env.JARVIS_BRAIN_PROVIDER = "gpt5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("is case-insensitive and trims JARVIS_BRAIN_PROVIDER", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.JARVIS_BRAIN_PROVIDER = "  GROQ  ";
    process.env.GROQ_API_KEY = "gsk-test";
    const config = loadConfig();
    expect(config.brainProvider).toBe("groq");
  });

  test("does not require ANTHROPIC_API_KEY when brainProvider is groq — a genuine $0 setup", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.JARVIS_BRAIN_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "gsk-test";
    const config = loadConfig();
    expect(config.anthropicApiKey).toBeUndefined();
    expect(config.groqApiKey).toBe("gsk-test");
  });

  test("throws when brainProvider is groq but GROQ_API_KEY is missing", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.JARVIS_BRAIN_PROVIDER = "groq";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("leaves groqModel undefined by default", () => {
    const config = loadConfig();
    expect(config.groqModel).toBeUndefined();
  });

  test("reads an explicit JARVIS_GROQ_MODEL override", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.JARVIS_BRAIN_PROVIDER = "groq";
    process.env.GROQ_API_KEY = "gsk-test";
    process.env.JARVIS_GROQ_MODEL = "llama-3.1-8b-instant";
    const config = loadConfig();
    expect(config.groqModel).toBe("llama-3.1-8b-instant");
  });

  test("loads with defaults when only the API key is set", () => {
    const config = loadConfig();
    expect(config.port).toBe(4770);
    expect(config.twilioAuthToken).toBeUndefined();
    expect(config.twilioPublicBaseUrl).toBeUndefined();
  });

  test("loads Twilio settings when both are provided along with an admin token", () => {
    process.env.TWILIO_AUTH_TOKEN = "token123";
    process.env.TWILIO_PUBLIC_BASE_URL = "https://example.ngrok.io";
    process.env.JARVIS_ADMIN_TOKEN = "admin-secret";

    const config = loadConfig();
    expect(config.twilioAuthToken).toBe("token123");
    expect(config.twilioPublicBaseUrl).toBe("https://example.ngrok.io");
    expect(config.adminToken).toBe("admin-secret");
  });

  test("throws when the phone gateway is configured without JARVIS_ADMIN_TOKEN", () => {
    process.env.TWILIO_AUTH_TOKEN = "token123";
    process.env.TWILIO_PUBLIC_BASE_URL = "https://example.ngrok.io";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("leaves adminToken undefined when the phone gateway isn't configured", () => {
    const config = loadConfig();
    expect(config.adminToken).toBeUndefined();
  });

  test("throws when only TWILIO_AUTH_TOKEN is set", () => {
    process.env.TWILIO_AUTH_TOKEN = "token123";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when only TWILIO_PUBLIC_BASE_URL is set", () => {
    process.env.TWILIO_PUBLIC_BASE_URL = "https://example.ngrok.io";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("loads outbound call settings when all three are set", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    process.env.TWILIO_FROM_NUMBER = "+15005550006";
    process.env.JARVIS_OWNER_PHONE_NUMBER = "+15551234567";

    const config = loadConfig();
    expect(config.twilioAccountSid).toBe("ACxxx");
    expect(config.twilioFromNumber).toBe("+15005550006");
    expect(config.ownerPhoneNumber).toBe("+15551234567");
  });

  test("leaves outbound call settings undefined when none are set", () => {
    const config = loadConfig();
    expect(config.twilioAccountSid).toBeUndefined();
    expect(config.twilioFromNumber).toBeUndefined();
    expect(config.ownerPhoneNumber).toBeUndefined();
  });

  test("throws when only some outbound call settings are set", () => {
    process.env.TWILIO_ACCOUNT_SID = "ACxxx";
    expect(() => loadConfig()).toThrow(ConfigError);

    process.env.TWILIO_FROM_NUMBER = "+15005550006";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults maxOutboundCallsPerDay to 10", () => {
    const config = loadConfig();
    expect(config.maxOutboundCallsPerDay).toBe(10);
  });

  test("reads JARVIS_MAX_OUTBOUND_CALLS_PER_DAY when set", () => {
    process.env.JARVIS_MAX_OUTBOUND_CALLS_PER_DAY = "3";
    const config = loadConfig();
    expect(config.maxOutboundCallsPerDay).toBe(3);
  });

  test("throws for a non-positive JARVIS_MAX_OUTBOUND_CALLS_PER_DAY", () => {
    process.env.JARVIS_MAX_OUTBOUND_CALLS_PER_DAY = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws for a non-integer JARVIS_MAX_OUTBOUND_CALLS_PER_DAY", () => {
    process.env.JARVIS_MAX_OUTBOUND_CALLS_PER_DAY = "2.5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("leaves anthropicBaseUrl undefined by default", () => {
    const config = loadConfig();
    expect(config.anthropicBaseUrl).toBeUndefined();
  });

  test("loads an explicit JARVIS_ANTHROPIC_BASE_URL override", () => {
    process.env.JARVIS_ANTHROPIC_BASE_URL = "http://localhost:20128";
    const config = loadConfig();
    expect(config.anthropicBaseUrl).toBe("http://localhost:20128");
  });

  test("leaves fallbackModel undefined by default", () => {
    const config = loadConfig();
    expect(config.fallbackModel).toBeUndefined();
  });

  test("loads an explicit JARVIS_FALLBACK_MODEL", () => {
    process.env.JARVIS_FALLBACK_MODEL = "claude-haiku-4-5-20251001";
    const config = loadConfig();
    expect(config.fallbackModel).toBe("claude-haiku-4-5-20251001");
  });

  test("loads Calendar settings when fully configured", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.JARVIS_PUBLIC_BASE_URL = "https://example.fly.dev";
    process.env.JARVIS_ADMIN_TOKEN = "admin-secret";

    const config = loadConfig();
    expect(config.googleClientId).toBe("client-id");
    expect(config.googleClientSecret).toBe("client-secret");
    expect(config.publicBaseUrl).toBe("https://example.fly.dev");
  });

  test("throws when only GOOGLE_CLIENT_ID is set", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when Calendar is configured without JARVIS_PUBLIC_BASE_URL", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when Calendar is configured without JARVIS_ADMIN_TOKEN", () => {
    process.env.GOOGLE_CLIENT_ID = "client-id";
    process.env.GOOGLE_CLIENT_SECRET = "client-secret";
    process.env.JARVIS_PUBLIC_BASE_URL = "https://example.fly.dev";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults JARVIS_CALENDAR_TOKEN_DB_PATH", () => {
    const config = loadConfig();
    expect(config.calendarTokenDbPath).toBe("./data/jarvis-calendar-tokens.sqlite");
  });

  test("loads Spotify settings when fully configured", () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-client-secret";
    process.env.JARVIS_PUBLIC_BASE_URL = "https://example.fly.dev";
    process.env.JARVIS_ADMIN_TOKEN = "admin-secret";

    const config = loadConfig();
    expect(config.spotifyClientId).toBe("spotify-client-id");
    expect(config.spotifyClientSecret).toBe("spotify-client-secret");
  });

  test("throws when only SPOTIFY_CLIENT_ID is set", () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when Spotify is configured without JARVIS_PUBLIC_BASE_URL", () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-client-secret";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when Spotify is configured without JARVIS_ADMIN_TOKEN", () => {
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-client-secret";
    process.env.JARVIS_PUBLIC_BASE_URL = "https://example.fly.dev";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults JARVIS_SPOTIFY_TOKEN_DB_PATH", () => {
    const config = loadConfig();
    expect(config.spotifyTokenDbPath).toBe("./data/jarvis-spotify-tokens.sqlite");
  });

  test("loads studio settings when both are set", () => {
    process.env.JARVIS_STUDIO_BASE_URL = "https://actually-works.com";
    process.env.JARVIS_STUDIO_SECRET = "studio-secret";

    const config = loadConfig();
    expect(config.studioBaseUrl).toBe("https://actually-works.com");
    expect(config.studioSecret).toBe("studio-secret");
  });

  test("leaves studio settings undefined when neither is set", () => {
    const config = loadConfig();
    expect(config.studioBaseUrl).toBeUndefined();
    expect(config.studioSecret).toBeUndefined();
  });

  test("throws when only JARVIS_STUDIO_BASE_URL is set", () => {
    process.env.JARVIS_STUDIO_BASE_URL = "https://actually-works.com";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when only JARVIS_STUDIO_SECRET is set", () => {
    process.env.JARVIS_STUDIO_SECRET = "studio-secret";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults JARVIS_WAKEUP_CALL_DB_PATH", () => {
    const config = loadConfig();
    expect(config.wakeUpCallDbPath).toBe("./data/jarvis-wakeup-calls.sqlite");
  });

  test("rejects an invalid JARVIS_PORT", () => {
    process.env.JARVIS_PORT = "not-a-number";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("parses TWILIO_ALLOWED_CALLERS into a trimmed, non-empty list", () => {
    process.env.TWILIO_ALLOWED_CALLERS = " +15551234567 ,+15557654321,";
    const config = loadConfig();
    expect(config.twilioAllowedCallers).toEqual(["+15551234567", "+15557654321"]);
  });

  test("leaves twilioAllowedCallers undefined when unset", () => {
    const config = loadConfig();
    expect(config.twilioAllowedCallers).toBeUndefined();
  });

  test("defaults twilioAllowOpenAccess to false", () => {
    const config = loadConfig();
    expect(config.twilioAllowOpenAccess).toBe(false);
  });

  test("reads TWILIO_ALLOW_OPEN_ACCESS=true", () => {
    process.env.TWILIO_ALLOW_OPEN_ACCESS = "true";
    const config = loadConfig();
    expect(config.twilioAllowOpenAccess).toBe(true);
  });

  test("reads TWILIO_VOICE when set", () => {
    process.env.TWILIO_VOICE = "Google.en-US-Chirp3-HD-Charon";
    const config = loadConfig();
    expect(config.twilioVoice).toBe("Google.en-US-Chirp3-HD-Charon");
  });

  test("leaves twilioVoice undefined when unset", () => {
    const config = loadConfig();
    expect(config.twilioVoice).toBeUndefined();
  });

  test("reads TWILIO_VOICE_HEBREW when set", () => {
    process.env.TWILIO_VOICE_HEBREW = "Google.he-IL-Wavenet-A";
    const config = loadConfig();
    expect(config.twilioVoiceHebrew).toBe("Google.he-IL-Wavenet-A");
  });

  test("leaves twilioVoiceHebrew undefined when unset", () => {
    const config = loadConfig();
    expect(config.twilioVoiceHebrew).toBeUndefined();
  });

  test("reads TWILIO_GATHER_LANGUAGE when set", () => {
    process.env.TWILIO_GATHER_LANGUAGE = "he-IL";
    const config = loadConfig();
    expect(config.twilioGatherLanguage).toBe("he-IL");
  });

  test("leaves twilioGatherLanguage undefined when unset", () => {
    const config = loadConfig();
    expect(config.twilioGatherLanguage).toBeUndefined();
  });

  test("reads TWILIO_VOICE_PITCH and TWILIO_VOICE_RATE when set", () => {
    process.env.TWILIO_VOICE_PITCH = "-20%";
    process.env.TWILIO_VOICE_RATE = "88%";
    const config = loadConfig();
    expect(config.twilioVoicePitch).toBe("-20%");
    expect(config.twilioVoiceRate).toBe("88%");
  });

  test("leaves twilioVoicePitch/twilioVoiceRate undefined when unset", () => {
    const config = loadConfig();
    expect(config.twilioVoicePitch).toBeUndefined();
    expect(config.twilioVoiceRate).toBeUndefined();
  });

  test("web search is disabled by default with the default max_uses", () => {
    const config = loadConfig();
    expect(config.webSearchEnabled).toBe(false);
    expect(config.webSearchMaxUses).toBe(5);
  });

  test("enables web search via JARVIS_WEB_SEARCH=true", () => {
    process.env.JARVIS_WEB_SEARCH = "true";
    const config = loadConfig();
    expect(config.webSearchEnabled).toBe(true);
  });

  test("reads a custom JARVIS_WEB_SEARCH_MAX_USES", () => {
    process.env.JARVIS_WEB_SEARCH_MAX_USES = "10";
    const config = loadConfig();
    expect(config.webSearchMaxUses).toBe(10);
  });

  test("rejects a non-positive JARVIS_WEB_SEARCH_MAX_USES", () => {
    process.env.JARVIS_WEB_SEARCH_MAX_USES = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("web fetch is disabled by default with the default max_uses", () => {
    const config = loadConfig();
    expect(config.webFetchEnabled).toBe(false);
    expect(config.webFetchMaxUses).toBe(5);
  });

  test("enables web fetch via JARVIS_WEB_FETCH=true", () => {
    process.env.JARVIS_WEB_FETCH = "true";
    const config = loadConfig();
    expect(config.webFetchEnabled).toBe(true);
  });

  test("reads a custom JARVIS_WEB_FETCH_MAX_USES", () => {
    process.env.JARVIS_WEB_FETCH_MAX_USES = "10";
    const config = loadConfig();
    expect(config.webFetchMaxUses).toBe(10);
  });

  test("rejects a non-positive JARVIS_WEB_FETCH_MAX_USES", () => {
    process.env.JARVIS_WEB_FETCH_MAX_USES = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("audio waveform is disabled by default", () => {
    const config = loadConfig();
    expect(config.audioWaveformEnabled).toBe(false);
  });

  test("enables the audio waveform via JARVIS_AUDIO_WAVEFORM=true", () => {
    process.env.JARVIS_AUDIO_WAVEFORM = "true";
    const config = loadConfig();
    expect(config.audioWaveformEnabled).toBe(true);
  });

  test("defaults timezone to UTC", () => {
    const config = loadConfig();
    expect(config.timezone).toBe("UTC");
  });

  test("reads a valid JARVIS_TIMEZONE", () => {
    process.env.JARVIS_TIMEZONE = "Asia/Jerusalem";
    const config = loadConfig();
    expect(config.timezone).toBe("Asia/Jerusalem");
  });

  test("rejects an invalid JARVIS_TIMEZONE", () => {
    process.env.JARVIS_TIMEZONE = "Not/A_Real_Zone";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("loads Telegram settings when bot token and webhook secret are both set", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    process.env.TELEGRAM_WEBHOOK_SECRET = "shh";
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = "111,222";

    const config = loadConfig();
    expect(config.telegramBotToken).toBe("123:abc");
    expect(config.telegramWebhookSecret).toBe("shh");
    expect(config.telegramAllowedChatIds).toEqual(["111", "222"]);
  });

  test("leaves Telegram settings undefined when none are set", () => {
    const config = loadConfig();
    expect(config.telegramBotToken).toBeUndefined();
    expect(config.telegramWebhookSecret).toBeUndefined();
    expect(config.telegramAllowedChatIds).toBeUndefined();
  });

  test("defaults telegramAllowOpenAccess to false", () => {
    const config = loadConfig();
    expect(config.telegramAllowOpenAccess).toBe(false);
  });

  test("reads TELEGRAM_ALLOW_OPEN_ACCESS=true", () => {
    process.env.TELEGRAM_ALLOW_OPEN_ACCESS = "true";
    const config = loadConfig();
    expect(config.telegramAllowOpenAccess).toBe(true);
  });

  test("throws when only the Telegram bot token is set, without the webhook secret", () => {
    process.env.TELEGRAM_BOT_TOKEN = "123:abc";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when only the Telegram webhook secret is set, without the bot token", () => {
    process.env.TELEGRAM_WEBHOOK_SECRET = "shh";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("loads weather settings when both latitude and longitude are set", () => {
    process.env.JARVIS_WEATHER_LATITUDE = "32.08";
    process.env.JARVIS_WEATHER_LONGITUDE = "34.78";

    const config = loadConfig();
    expect(config.weatherLatitude).toBe(32.08);
    expect(config.weatherLongitude).toBe(34.78);
  });

  test("leaves weather settings undefined when neither is set", () => {
    const config = loadConfig();
    expect(config.weatherLatitude).toBeUndefined();
    expect(config.weatherLongitude).toBeUndefined();
  });

  test("throws when only weather latitude is set, without longitude", () => {
    process.env.JARVIS_WEATHER_LATITUDE = "32.08";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when weather latitude is not a valid number", () => {
    process.env.JARVIS_WEATHER_LATITUDE = "not-a-number";
    process.env.JARVIS_WEATHER_LONGITUDE = "34.78";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when latitude is out of the valid -90..90 range", () => {
    process.env.JARVIS_WEATHER_LATITUDE = "185";
    process.env.JARVIS_WEATHER_LONGITUDE = "34.78";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("throws when longitude is out of the valid -180..180 range", () => {
    process.env.JARVIS_WEATHER_LATITUDE = "32.08";
    process.env.JARVIS_WEATHER_LONGITUDE = "-200";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("reads JARVIS_NEWS_RSS_URL when set", () => {
    process.env.JARVIS_NEWS_RSS_URL = "https://example.com/feed.xml";
    const config = loadConfig();
    expect(config.newsRssUrl).toBe("https://example.com/feed.xml");
  });

  test("leaves newsRssUrl undefined when unset", () => {
    const config = loadConfig();
    expect(config.newsRssUrl).toBeUndefined();
  });

  test("loads weekly digest settings when both are set", () => {
    process.env.JARVIS_WEEKLY_DIGEST_DAY = "1";
    process.env.JARVIS_WEEKLY_DIGEST_TIME = "09:00";
    const config = loadConfig();
    expect(config.weeklyDigestDayOfWeek).toBe(1);
    expect(config.weeklyDigestTime).toBe("09:00");
  });

  test("leaves weekly digest settings undefined when neither is set", () => {
    const config = loadConfig();
    expect(config.weeklyDigestDayOfWeek).toBeUndefined();
    expect(config.weeklyDigestTime).toBeUndefined();
  });

  test("throws when only weekly digest day is set, without time", () => {
    process.env.JARVIS_WEEKLY_DIGEST_DAY = "1";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects an out-of-range weekly digest day", () => {
    process.env.JARVIS_WEEKLY_DIGEST_DAY = "7";
    process.env.JARVIS_WEEKLY_DIGEST_TIME = "09:00";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects an invalid weekly digest time", () => {
    process.env.JARVIS_WEEKLY_DIGEST_DAY = "1";
    process.env.JARVIS_WEEKLY_DIGEST_TIME = "25:99";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("reads JARVIS_CHECKIN_AFTER_HOURS when set", () => {
    process.env.JARVIS_CHECKIN_AFTER_HOURS = "24";
    const config = loadConfig();
    expect(config.checkinAfterHours).toBe(24);
  });

  test("leaves checkinAfterHours undefined when unset", () => {
    const config = loadConfig();
    expect(config.checkinAfterHours).toBeUndefined();
  });

  test("rejects a non-positive JARVIS_CHECKIN_AFTER_HOURS", () => {
    process.env.JARVIS_CHECKIN_AFTER_HOURS = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("reads JARVIS_MORNING_BRIEFING_TIME when set", () => {
    process.env.JARVIS_MORNING_BRIEFING_TIME = "07:00";
    const config = loadConfig();
    expect(config.morningBriefingTime).toBe("07:00");
  });

  test("leaves morningBriefingTime undefined when unset", () => {
    const config = loadConfig();
    expect(config.morningBriefingTime).toBeUndefined();
  });

  test("rejects an invalid JARVIS_MORNING_BRIEFING_TIME", () => {
    process.env.JARVIS_MORNING_BRIEFING_TIME = "7am";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("reads JARVIS_COST_ALERT_THRESHOLD_USD when set", () => {
    process.env.JARVIS_COST_ALERT_THRESHOLD_USD = "25";
    const config = loadConfig();
    expect(config.costAlertThresholdUsd).toBe(25);
  });

  test("leaves costAlertThresholdUsd undefined when unset", () => {
    const config = loadConfig();
    expect(config.costAlertThresholdUsd).toBeUndefined();
  });

  test("rejects a non-positive JARVIS_COST_ALERT_THRESHOLD_USD", () => {
    process.env.JARVIS_COST_ALERT_THRESHOLD_USD = "0";
    expect(() => loadConfig()).toThrow(ConfigError);

    process.env.JARVIS_COST_ALERT_THRESHOLD_USD = "-5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects a non-numeric JARVIS_COST_ALERT_THRESHOLD_USD", () => {
    process.env.JARVIS_COST_ALERT_THRESHOLD_USD = "not-a-number";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults brainProviderExplicit to false when JARVIS_BRAIN_PROVIDER is unset", () => {
    const config = loadConfig();
    expect(config.brainProviderExplicit).toBe(false);
  });

  test("sets brainProviderExplicit to true when JARVIS_BRAIN_PROVIDER is explicitly set", () => {
    process.env.JARVIS_BRAIN_PROVIDER = "anthropic";
    const config = loadConfig();
    expect(config.brainProviderExplicit).toBe(true);
  });

  test("allows both ANTHROPIC_API_KEY and GROQ_API_KEY to be set together", () => {
    process.env.GROQ_API_KEY = "gsk-test";
    const config = loadConfig();
    expect(config.anthropicApiKey).toBe("sk-ant-test-key");
    expect(config.groqApiKey).toBe("gsk-test");
  });

  test("throws when neither ANTHROPIC_API_KEY nor GROQ_API_KEY is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults aiFreeFirst to true", () => {
    const config = loadConfig();
    expect(config.aiFreeFirst).toBe(true);
  });

  test("reads AI_FREE_FIRST=false", () => {
    process.env.AI_FREE_FIRST = "false";
    const config = loadConfig();
    expect(config.aiFreeFirst).toBe(false);
  });

  test("leaves aiFallbackProvider undefined by default", () => {
    const config = loadConfig();
    expect(config.aiFallbackProvider).toBeUndefined();
  });

  test("reads a valid AI_FALLBACK_PROVIDER", () => {
    process.env.GROQ_API_KEY = "gsk-test";
    process.env.AI_FALLBACK_PROVIDER = "groq";
    const config = loadConfig();
    expect(config.aiFallbackProvider).toBe("groq");
  });

  test("rejects an invalid AI_FALLBACK_PROVIDER", () => {
    process.env.AI_FALLBACK_PROVIDER = "gpt5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("leaves maxDailyCostUsd/maxMonthlyCostUsd undefined by default", () => {
    const config = loadConfig();
    expect(config.maxDailyCostUsd).toBeUndefined();
    expect(config.maxMonthlyCostUsd).toBeUndefined();
  });

  test("reads MAX_DAILY_COST_USD and MAX_MONTHLY_COST_USD when set", () => {
    process.env.MAX_DAILY_COST_USD = "5";
    process.env.MAX_MONTHLY_COST_USD = "50";
    const config = loadConfig();
    expect(config.maxDailyCostUsd).toBe(5);
    expect(config.maxMonthlyCostUsd).toBe(50);
  });

  test("rejects a non-positive MAX_DAILY_COST_USD", () => {
    process.env.MAX_DAILY_COST_USD = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects a non-positive MAX_MONTHLY_COST_USD", () => {
    process.env.MAX_MONTHLY_COST_USD = "-1";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults zeroCostMode to false", () => {
    const config = loadConfig();
    expect(config.zeroCostMode).toBe(false);
  });

  test("reads ZERO_COST_MODE=true", () => {
    process.env.ZERO_COST_MODE = "true";
    const config = loadConfig();
    expect(config.zeroCostMode).toBe(true);
  });

  test("anything other than the literal string true leaves ZERO_COST_MODE off", () => {
    process.env.ZERO_COST_MODE = "1";
    const config = loadConfig();
    expect(config.zeroCostMode).toBe(false);
  });

  test("defaults aiCircuitBreakerThreshold and aiCircuitBreakerCooldownMs", () => {
    const config = loadConfig();
    expect(config.aiCircuitBreakerThreshold).toBe(3);
    expect(config.aiCircuitBreakerCooldownMs).toBe(60_000);
  });

  test("reads AI_CIRCUIT_BREAKER_THRESHOLD and AI_CIRCUIT_BREAKER_COOLDOWN_MS when set", () => {
    process.env.AI_CIRCUIT_BREAKER_THRESHOLD = "5";
    process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS = "30000";
    const config = loadConfig();
    expect(config.aiCircuitBreakerThreshold).toBe(5);
    expect(config.aiCircuitBreakerCooldownMs).toBe(30_000);
  });

  test("rejects a non-positive AI_CIRCUIT_BREAKER_THRESHOLD", () => {
    process.env.AI_CIRCUIT_BREAKER_THRESHOLD = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects a non-integer AI_CIRCUIT_BREAKER_COOLDOWN_MS", () => {
    process.env.AI_CIRCUIT_BREAKER_COOLDOWN_MS = "1.5";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("defaults aiCostDbPath", () => {
    const config = loadConfig();
    expect(config.aiCostDbPath).toBe("./data/jarvis-ai-cost.sqlite");
  });

  test("reads TELEGRAM_OWNER_CHAT_ID when set", () => {
    process.env.TELEGRAM_OWNER_CHAT_ID = "12345";
    const config = loadConfig();
    expect(config.telegramOwnerChatId).toBe("12345");
  });

  test("leaves telegramOwnerChatId undefined when unset", () => {
    const config = loadConfig();
    expect(config.telegramOwnerChatId).toBeUndefined();
  });

  test("defaults commitmentsDbPath and staleCommitmentDays", () => {
    const config = loadConfig();
    expect(config.commitmentsDbPath).toBe("./data/jarvis-commitments.sqlite");
    expect(config.staleCommitmentDays).toBe(3);
  });

  test("reads JARVIS_STALE_COMMITMENT_DAYS when set", () => {
    process.env.JARVIS_STALE_COMMITMENT_DAYS = "7";
    const config = loadConfig();
    expect(config.staleCommitmentDays).toBe(7);
  });

  test("rejects a non-positive JARVIS_STALE_COMMITMENT_DAYS", () => {
    process.env.JARVIS_STALE_COMMITMENT_DAYS = "0";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("quiet hours is disabled (undefined) when neither var is set", () => {
    const config = loadConfig();
    expect(config.quietHoursStart).toBeUndefined();
    expect(config.quietHoursEnd).toBeUndefined();
  });

  test("reads JARVIS_QUIET_HOURS_START/_END when both set", () => {
    process.env.JARVIS_QUIET_HOURS_START = "22:00";
    process.env.JARVIS_QUIET_HOURS_END = "07:00";
    const config = loadConfig();
    expect(config.quietHoursStart).toBe("22:00");
    expect(config.quietHoursEnd).toBe("07:00");
  });

  test("rejects JARVIS_QUIET_HOURS_START set without JARVIS_QUIET_HOURS_END", () => {
    process.env.JARVIS_QUIET_HOURS_START = "22:00";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects JARVIS_QUIET_HOURS_END set without JARVIS_QUIET_HOURS_START", () => {
    process.env.JARVIS_QUIET_HOURS_END = "07:00";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects an invalid JARVIS_QUIET_HOURS_START format", () => {
    process.env.JARVIS_QUIET_HOURS_START = "10pm";
    process.env.JARVIS_QUIET_HOURS_END = "07:00";
    expect(() => loadConfig()).toThrow(ConfigError);
  });

  test("rejects an invalid JARVIS_QUIET_HOURS_END format", () => {
    process.env.JARVIS_QUIET_HOURS_START = "22:00";
    process.env.JARVIS_QUIET_HOURS_END = "25:00";
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});

describe("redactConfigForDisplay", () => {
  test("never includes the real value of any secret field, anywhere in the serialized output", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-REAL-SECRET-VALUE";
    process.env.GROQ_API_KEY = "gsk-REAL-SECRET-VALUE";
    process.env.TWILIO_AUTH_TOKEN = "twilio-REAL-SECRET-VALUE";
    process.env.TWILIO_PUBLIC_BASE_URL = "https://example.com";
    process.env.JARVIS_PUBLIC_BASE_URL = "https://example.com";
    process.env.JARVIS_ADMIN_TOKEN = "admin-REAL-SECRET-VALUE";
    process.env.TELEGRAM_BOT_TOKEN = "telegram-REAL-SECRET-VALUE";
    process.env.TELEGRAM_WEBHOOK_SECRET = "webhook-REAL-SECRET-VALUE";
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "google-REAL-SECRET-VALUE";
    process.env.SPOTIFY_CLIENT_ID = "spotify-client-id";
    process.env.SPOTIFY_CLIENT_SECRET = "spotify-REAL-SECRET-VALUE";
    process.env.JARVIS_STUDIO_BASE_URL = "https://studio.example.com";
    process.env.JARVIS_STUDIO_SECRET = "studio-REAL-SECRET-VALUE";

    const config = loadConfig();
    const redacted = redactConfigForDisplay(config);
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("REAL-SECRET-VALUE");
    expect(redacted.anthropicApiKey).toEqual({ configured: true });
    expect(redacted.groqApiKey).toEqual({ configured: true });
    expect(redacted.twilioAuthToken).toEqual({ configured: true });
    expect(redacted.adminToken).toEqual({ configured: true });
    expect(redacted.telegramBotToken).toEqual({ configured: true });
    expect(redacted.telegramWebhookSecret).toEqual({ configured: true });
    expect(redacted.googleClientSecret).toEqual({ configured: true });
    expect(redacted.spotifyClientSecret).toEqual({ configured: true });
    expect(redacted.studioSecret).toEqual({ configured: true });
  });

  test("reports an unset secret as not configured", () => {
    delete process.env.JARVIS_ADMIN_TOKEN;
    const config = loadConfig();
    const redacted = redactConfigForDisplay(config);

    expect(redacted.adminToken).toEqual({ configured: false });
  });

  test("passes non-secret fields through unchanged", () => {
    process.env.JARVIS_TIMEZONE = "Asia/Jerusalem";
    process.env.JARVIS_PORT = "5555";
    const config = loadConfig();
    const redacted = redactConfigForDisplay(config);

    expect(redacted.timezone).toBe("Asia/Jerusalem");
    expect(redacted.port).toBe(5555);
  });
});
