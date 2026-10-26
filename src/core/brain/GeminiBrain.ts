import { randomUUID } from "node:crypto";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";

// "gemini-2.0-flash" is this file's best-effort pick for a fast, genuinely
// free-tier-eligible model on Google AI Studio's free tier
// (generativelanguage.googleapis.com, no credit card) as of this writing —
// NOT independently verified against Google's own current free-tier model
// list from inside this sandbox (no outbound access to confirm it live,
// same caveat GroqBrain/OpenRouterBrain's own doc comments are honest
// about for their picks). JARVIS_GEMINI_MODEL overrides this; check
// https://ai.google.dev/gemini-api/docs/pricing for Google's current
// free-tier model list before relying on this default in production.
export const DEFAULT_GEMINI_MODEL = "gemini-2.0-flash";
const DEFAULT_MAX_TOKENS = 1024;
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;

interface GeminiTextPart {
  text: string;
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: Record<string, unknown> };
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: Record<string, unknown> };
}
interface GeminiInlineDataPart {
  inlineData: { mimeType: string; data: string };
}
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart | GeminiInlineDataPart;

interface GeminiContent {
  /** Gemini only knows "user" and "model" — there is no separate "system"/"tool" role for ordinary turns; a function result is sent back as a "user" turn carrying a functionResponse part (confirmed against Google's own current function-calling docs: the sample conversation history appends `Content(role="user", parts=[function_response_part])`, not a dedicated "function" role). */
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiFunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Talks to Google's Gemini REST API (`generateContent`) — a genuinely free
 * option (Google AI Studio's free tier: no credit card, a `GEMINI_API_KEY`
 * from https://aistudio.google.com/apikey) alongside Groq/OpenRouter/
 * Cloudflare Workers AI.
 *
 * Unlike OpenRouterBrain's `:free`-suffix enforcement (needed because
 * OpenRouter is a mixed paid/free marketplace under one API), Gemini's
 * free tier is scoped to the API key/project itself — Google AI Studio
 * keys default to the free tier's own rate limits (requests/minute,
 * requests/day) and simply return a 429 once exhausted, rather than any
 * model id carrying a price tag the way OpenRouter's catalog does. So
 * there is no analogous "refuse to construct" check here: any model this
 * class is pointed at (via `JARVIS_GEMINI_MODEL`) is exactly as free or
 * paid as the API key's own billing status, which this class has no way
 * to introspect — same reasoning CloudflareWorkersAIBrain applies to its
 * own user-chosen `CLOUDFLARE_MODEL`.
 *
 * Message/tool-call translation is genuinely different from the OpenAI-
 * compatible shape Groq/OpenRouter/Cloudflare share: Gemini's API uses its
 * own `contents`/`parts` structure, `functionDeclarations` for tools (not
 * `tools[].function`), and `functionCall`/`functionResponse` parts (not
 * `tool_calls`/a `tool`-role message) — see `toGeminiContents`/
 * `fromGeminiResponse` below.
 */
export class GeminiBrain implements Brain {
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly baseUrl: string;
  private readonly retryDelayMs: number;

  constructor(
    private readonly apiKey: string,
    options: { model?: string; maxTokens?: number; baseUrl?: string; retryDelayMs?: number } = {}
  ) {
    this.model = options.model ?? DEFAULT_GEMINI_MODEL;
    this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    this.baseUrl = options.baseUrl ?? GEMINI_API_BASE_URL;
    // Test-only override — production always uses the real backoff delay.
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const { contents, systemInstruction } = toGeminiContents(request.messages, request.context);
    const functionDeclarations = toGeminiFunctionDeclarations(request.tools);

    const body = {
      contents,
      systemInstruction,
      tools: functionDeclarations.length > 0 ? [{ functionDeclarations }] : undefined,
      generationConfig: { maxOutputTokens: this.maxTokens },
    };

    const url = `${this.baseUrl}/models/${this.model}:generateContent`;

    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          // The documented header form of API-key auth — avoids putting the
          // key in the URL (and therefore in server/proxy access logs) the
          // way Gemini's own `?key=` query-param form would.
          "x-goog-api-key": this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.ok) {
        return fromGeminiResponse((await response.json()) as GeminiGenerateContentResponse);
      }

      // Only 429 (free-tier rate limit) and 503 (transient overload) are
      // worth retrying — a 400/401/403 would fail identically every time.
      if ((response.status === 429 || response.status === 503) && attempt < MAX_RETRIES) {
        lastError = new Error(`Gemini generateContent failed (${response.status})`);
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
        continue;
      }

      const detail = await response.text().catch(() => "");
      throw new Error(`Gemini generateContent failed (${response.status}): ${detail}`);
    }

    throw lastError ?? new Error("Gemini generateContent failed after retries");
  }
}

/**
 * Translates JARVIS's provider-agnostic conversation into Gemini's own
 * `contents`/`parts` shape. Unlike the OpenAI-compatible providers, system
 * context is never folded into the turn list — Gemini has a dedicated
 * top-level `systemInstruction` field instead.
 */
function toGeminiContents(
  messages: ConversationMessage[],
  systemContext?: string
): { contents: GeminiContent[]; systemInstruction?: { parts: GeminiTextPart[] } } {
  const contents: GeminiContent[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      const parts: GeminiPart[] = (message.images ?? []).map((image) => ({
        inlineData: { mimeType: image.mediaType, data: image.data },
      }));
      if (message.content) parts.push({ text: message.content });
      contents.push({ role: "user", parts });
      continue;
    }

    if (message.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (message.content) parts.push({ text: message.content });
      for (const call of message.toolCalls ?? []) {
        parts.push({ functionCall: { name: call.toolName, args: call.input } });
      }
      // Gemini's "model" role is the only valid role for the assistant's
      // own prior turn (there is no "assistant" alias the way some
      // OpenAI-compatible layers accept).
      contents.push({ role: "model", parts });
      continue;
    }

    // Tool result — sent back as a "user" turn carrying a functionResponse
    // part (see GeminiContent's own doc comment for why "user", not a
    // dedicated "function" role). Gemini matches a function response to
    // its call by `name`, not by call id, so `toolCallId` (JARVIS's own
    // bookkeeping id) has no Gemini-side equivalent to carry across.
    contents.push({
      role: "user",
      parts: [{ functionResponse: { name: message.toolName, response: { content: message.content } } }],
    });
  }

  return {
    contents,
    systemInstruction: systemContext ? { parts: [{ text: systemContext }] } : undefined,
  };
}

function toGeminiFunctionDeclarations(tools: ToolDefinition[]): GeminiFunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.input_schema,
  }));
}

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  /** Echoed back on some API versions — the model that actually served this call, for CostTracker's per-model ledger. Not every response carries it. */
  modelVersion?: string;
}

/** Exported for unit testing without a network call — pure response-shaping logic. */
export function fromGeminiResponse(response: GeminiGenerateContentResponse): BrainResponse {
  // Defensive: a malformed/error-shaped body shouldn't throw an uncaught
  // TypeError here — same reasoning as every other Brain's own
  // fromXResponse (see GroqBrain/OpenRouterBrain/CloudflareWorkersAIBrain).
  const candidate = Array.isArray(response.candidates) ? response.candidates[0] : undefined;
  const parts = candidate?.content?.parts ?? [];

  const text = parts
    .filter((part): part is GeminiTextPart => "text" in part)
    .map((part) => part.text)
    .join("");

  const toolCalls: ToolCallRequest[] = parts
    .filter((part): part is GeminiFunctionCallPart => "functionCall" in part)
    .map((part) => ({
      // Gemini's own functionCall part carries no call id (unlike OpenAI's/
      // Anthropic's tool-call shapes) — JARVIS's ToolCallRequest.id is
      // purely internal bookkeeping (matching a later tool-result message
      // back to the call that produced it), so a synthesized id is exactly
      // as valid as a provider-issued one here.
      id: randomUUID(),
      toolName: part.functionCall.name,
      input: part.functionCall.args ?? {},
    }));

  return {
    text,
    toolCalls,
    stopReason: candidate?.finishReason ?? "unknown",
    usage: response.usageMetadata
      ? {
          inputTokens: response.usageMetadata.promptTokenCount ?? 0,
          outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
          // Gemini's free tier doesn't do Anthropic-style prompt caching —
          // always 0, honestly, rather than omitting the fields.
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
        }
      : undefined,
    model: response.modelVersion,
  };
}
