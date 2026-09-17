export interface JarvisConfig {
  anthropicApiKey: string;
  port: number;
  memoryDbPath: string;
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

  return { anthropicApiKey, port, memoryDbPath };
}

export { ConfigError };
