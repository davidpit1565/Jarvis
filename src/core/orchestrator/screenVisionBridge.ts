import type { ToolCallRequest, UserMessage, UserMessageImage } from "@/types/conversation";
import type { ToolResult } from "@/types/tools";
import { isLookAtScreenImageData, LOOK_AT_SCREEN_TOOL_NAME } from "@/tools/system/LookAtScreenTool";

/**
 * The Vision Bridge: the one mechanism that lets a TOOL CALL's result put a
 * real image in front of the model within the same turn's tool-calling
 * loop. Before this, images only ever entered a conversation as part of a
 * brand-new `UserMessage` from a human-operated channel (see
 * `Orchestrator.handleUserMessage`'s own `images` parameter) — there was no
 * image-aware path for a `ToolResultMessage`, whose `content` is a plain
 * `string` with no consumer that reads an image out of it.
 *
 * Deliberately narrow, not a generic "any tool can return an image"
 * feature: this file only ever recognizes `LOOK_AT_SCREEN_TOOL_NAME`'s own
 * result shape (`LookAtScreenImageData`). A generic version would be more
 * risk than this one concrete use case needs — see the task this was built
 * for.
 *
 * Mechanism chosen (there were two real options):
 *   (a) Special-case this one tool's result in the Orchestrator's tool loop:
 *       extract the image and attach it as a synthetic `UserMessageImage`
 *       on the NEXT brain request in the same turn, rather than trying to
 *       put raw image bytes into `ToolResultMessage.content` (typed as
 *       `string`, no image-aware consumer anywhere downstream).
 *   (b) Teach `ConversationManager`/`ToolResultMessage` a new image-bearing
 *       shape and every `Brain` implementation to read images off a tool
 *       result directly.
 * (a) was chosen: it reuses `AIRouter`'s existing, already-tested
 * `requestNeedsVision`/`providerSupportsVision` routing completely
 * unchanged (that logic only ever looks at `role === "user"` messages'
 * `images` field — see `AIRouter.ts`), and it reuses every `Brain`
 * provider's existing image-serialization code (e.g.
 * `ClaudeBrain.toAnthropicMessages`'s `message.images?.length` branch)
 * with zero new provider-side code. (b) would have meant widening
 * `ToolResultMessage`'s type and touching every `Brain` implementation for
 * a capability exactly one tool needs today. This codebase's tool-result
 * loop already pushes more than one `role: "user"` message back-to-back in
 * a single turn when several tool calls run in one batch (each
 * `ToolResultMessage` becomes its own `{role: "user", content: [tool_result]}`
 * turn in `toAnthropicMessages`) — so appending one more synthetic
 * `role: "user"` turn after them is consistent with how this conversation
 * shape already works, not a new pattern.
 *
 * The bridge is one-shot and never persisted: `Orchestrator.handleUserMessage`
 * attaches the image to the very next `brain.chat()` call's message array
 * only, then discards it — it is never written into `ConversationManager`,
 * so a multi-megabyte screenshot never gets resent on every later turn of a
 * long conversation. `redactScreenVisionPayload` is what keeps the
 * permanent, `ConversationManager`-backed tool-result text small instead.
 */

/** The media types Anthropic's own `UserMessageImage` contract allows. */
const VALID_MEDIA_TYPES: ReadonlySet<UserMessageImage["mediaType"]> = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

/**
 * Pulls a real image out of a successful LOOK_AT_SCREEN tool result, or
 * returns `undefined` for any other tool, a failed result, a malformed
 * payload, or one that exceeds `maxBase64Length` (the same cap
 * `Orchestrator.handleUserMessage` already enforces on a human-attached
 * image — see `MAX_IMAGE_BASE64_LENGTH`). An oversized/malformed image is
 * never silently truncated here: the caller just gets `undefined` and the
 * turn proceeds with the tool's ordinary text result, nothing more
 * dramatic than "the image didn't make it into this step."
 */
export function extractScreenVisionImage(
  toolCall: ToolCallRequest,
  result: ToolResult,
  maxBase64Length: number
): UserMessageImage | undefined {
  if (toolCall.toolName !== LOOK_AT_SCREEN_TOOL_NAME) return undefined;
  if (!result.success) return undefined;
  if (!isLookAtScreenImageData(result.data)) return undefined;
  if (result.data.data.length > maxBase64Length) return undefined;
  if (!VALID_MEDIA_TYPES.has(result.data.mediaType)) return undefined;

  return { mediaType: result.data.mediaType, data: result.data.data };
}

/** Short placeholder swapped in for the raw base64 payload before a LOOK_AT_SCREEN result is written into permanent conversation history. */
const REDACTED_PAYLOAD_NOTE =
  "[image bytes omitted from conversation history — already provided to you directly as a vision input on your next step]";

/**
 * Returns `result` unchanged unless it's a successful LOOK_AT_SCREEN result
 * carrying an image payload, in which case the base64 `data` field is
 * replaced with a short placeholder. Called before the result is ever
 * stringified into `ConversationManager.addToolResult` — the real bytes
 * only ever live transiently in the one synthetic brain-request message
 * `buildScreenVisionMessage` builds, never in persisted conversation state.
 */
export function redactScreenVisionPayload(toolCall: ToolCallRequest, result: ToolResult): ToolResult {
  if (toolCall.toolName !== LOOK_AT_SCREEN_TOOL_NAME) return result;
  if (!result.success || !isLookAtScreenImageData(result.data)) return result;

  return {
    ...result,
    data: { ...result.data, data: REDACTED_PAYLOAD_NOTE },
  };
}

/**
 * Builds the synthetic `UserMessage` appended (never persisted — see this
 * file's own doc comment) to the next `brain.chat()` call's message array
 * so the model's very next step genuinely sees the screenshot via
 * `AIRouter`'s real vision routing.
 */
export function buildScreenVisionMessage(images: UserMessageImage[]): UserMessage {
  return {
    role: "user",
    content:
      "[A screenshot was just captured on the device — see the attached image. Comment on the actual, specific " +
      "contents you can see, not just that a screenshot exists.]",
    images,
  };
}
