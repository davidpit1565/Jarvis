/**
 * Builds an error for a failed external API call whose status code is
 * safe and useful (the caller/model can react to a 401/403/429/5xx), but
 * whose raw response body is not: a Google/Spotify API's own JSON error
 * body can include internal reason strings, echoed request fragments, or
 * other backend detail never meant for the end user, and every one of
 * these clients' tool wrappers passes a thrown Error's message straight
 * through as the ToolResult's `error` field with no sanitization — which
 * ultimately reaches the model's context and can get relayed to Telegram/
 * web chat/voice verbatim. The raw body is logged server-side only, for
 * debugging; the thrown message carries just the status code, matching
 * the same "never surface a raw backend error" fix already applied to
 * the Telegram/automation-rule failure paths.
 */
export async function apiError(context: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  if (body) {
    console.error(`[jarvis] ${context} (${response.status}):`, body);
  }
  return new Error(`${context} (${response.status})`);
}
