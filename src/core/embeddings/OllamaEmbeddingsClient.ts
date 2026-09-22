import { fetchWithRetry } from "@/core/net/fetchWithRetry";

export interface OllamaEmbeddingsClientOptions {
  /** Base URL of a locally-run Ollama server. Defaults to "http://localhost:11434" — same default host:port as the OllamaBrain chat provider, since both talk to the same one Ollama server. */
  baseUrl?: string;
  /** The embedding model to request (e.g. "nomic-embed-text"). Must be pulled into Ollama first (`ollama pull nomic-embed-text`) — this client has no way to pull it on the caller's behalf. */
  model: string;
}

/** Thrown for both "Ollama isn't reachable at all" and "Ollama responded but not with a usable embedding" — a clear, typed error rather than a raw fetch/JSON exception, mirroring how OllamaBrain reports its own connection failures. */
export class OllamaEmbeddingsError extends Error {}

/**
 * A small client for Ollama's `POST /api/embeddings` endpoint — genuinely
 * free, local, no API key, no rate limit beyond the local machine's own
 * compute. This is the piece that finally removes the "would need a paid
 * embeddings API" blocker JARVIS_ROADMAP_AUDIT.md's Semantic Cache entry
 * (#60) cited for skipping semantic search/caching entirely.
 *
 * Deliberately minimal: one method, no batching, no connection pooling —
 * every caller in this codebase (MemoryStore's semantic search,
 * ToolResultCache's semantic layer) embeds one short piece of text at a
 * time, at personal-assistant scale, not in bulk.
 */
export class OllamaEmbeddingsClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OllamaEmbeddingsClientOptions) {
    this.baseUrl = (options.baseUrl?.trim() || "http://localhost:11434").replace(/\/+$/, "");
    this.model = options.model;
  }

  /**
   * Returns the embedding vector for `text`. Throws `OllamaEmbeddingsError`
   * — never a crash, never a silently-empty vector — when Ollama isn't
   * running, isn't reachable at the configured base URL, or the requested
   * model isn't pulled. Every caller of this client treats embeddings as an
   * optional enhancement and must catch this and fall back to exact-match
   * behavior, exactly as OllamaBrain's own callers would treat an
   * unreachable chat server.
   */
  async embed(text: string): Promise<number[]> {
    let response: Response;
    try {
      response = await fetchWithRetry(`${this.baseUrl}/api/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, prompt: text }),
      });
    } catch (error) {
      throw new OllamaEmbeddingsError(
        `Could not reach Ollama at ${this.baseUrl} for embeddings — is "ollama serve" running and is the model ` +
          `pulled (ollama pull ${this.model})? (${error instanceof Error ? error.message : String(error)})`
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new OllamaEmbeddingsError(
        `Ollama embeddings request failed with status ${response.status}${body ? `: ${body}` : ""}`
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (error) {
      throw new OllamaEmbeddingsError(
        `Ollama embeddings response was not valid JSON (${error instanceof Error ? error.message : String(error)})`
      );
    }

    const embedding = (json as { embedding?: unknown } | null)?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0 || !embedding.every((v) => typeof v === "number")) {
      throw new OllamaEmbeddingsError('Ollama embeddings response did not contain a numeric "embedding" array');
    }
    return embedding as number[];
  }
}
