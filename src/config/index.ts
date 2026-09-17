export interface JarvisConfig {
  anthropicApiKey: string;
  port: number;
  memoryDbPath: string;
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

  return {
    anthropicApiKey,
    port,
    memoryDbPath,
    twilioAuthToken,
    twilioPublicBaseUrl,
    twilioAllowedCallers,
    twilioVoice,
  };
}

export { ConfigError };
