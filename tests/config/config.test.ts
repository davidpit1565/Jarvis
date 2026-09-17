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
  "JARVIS_ADMIN_TOKEN",
  "JARVIS_WEB_SEARCH",
  "JARVIS_WEB_SEARCH_MAX_USES",
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
});
