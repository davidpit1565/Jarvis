import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, ConfigError } from "@/config";

const ENV_KEYS = [
  "ANTHROPIC_API_KEY",
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
  "JARVIS_WAKEUP_CALL_DB_PATH",
  "JARVIS_ANTHROPIC_BASE_URL",
  "JARVIS_PUBLIC_BASE_URL",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "JARVIS_CALENDAR_TOKEN_DB_PATH",
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

  test("leaves anthropicBaseUrl undefined by default", () => {
    const config = loadConfig();
    expect(config.anthropicBaseUrl).toBeUndefined();
  });

  test("loads an explicit JARVIS_ANTHROPIC_BASE_URL override", () => {
    process.env.JARVIS_ANTHROPIC_BASE_URL = "http://localhost:20128";
    const config = loadConfig();
    expect(config.anthropicBaseUrl).toBe("http://localhost:20128");
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
});
