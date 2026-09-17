import Anthropic from "@anthropic-ai/sdk";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ConversationMessage, ToolCallRequest } from "@/types/conversation";
import type { ToolDefinition } from "@/types/tools";

type ContentBlockParam = Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam;

const DEFAULT_MODEL = "claude-sonnet-4-5-20250929";
const DEFAULT_MAX_TOKENS = 1024;
const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com";

/**
 * Talks to Anthropic's Messages API. This class only decides *what* Claude
 * wants to happen next (text and/or tool calls) — it never executes tools
 * itself. The orchestrator owns that decision.
 */
export class ClaudeBrain implements Brain {
  private client: Anthropic;

  constructor(
    apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly maxTokens: number = DEFAULT_MAX_TOKENS
  ) {
    // baseURL is pinned explicitly: the Anthropic SDK otherwise honors an
    // ambient ANTHROPIC_BASE_URL environment variable, which on a
    // developer's machine may point at an unrelated local proxy/router
    // (e.g. a different AI tool) — JARVIS must always talk to the real
    // Anthropic API regardless of what else is configured on the host.
    this.client = new Anthropic({ apiKey, baseURL: ANTHROPIC_API_BASE_URL });
  }

  async chat(request: BrainRequest): Promise<BrainResponse> {
    const messages = toAnthropicMessages(request.messages);
    const system = request.context ? request.context : undefined;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system,
      messages,
      tools: request.tools.length > 0 ? toAnthropicTools(request.tools) : undefined,
    });

    return fromAnthropicResponse(response);
  }
}

function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(messages: ConversationMessage[]): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const message of messages) {
    if (message.role === "user") {
      result.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const content: ContentBlockParam[] = [];
      if (message.content) {
        content.push({ type: "text", text: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        content.push({ type: "tool_use", id: call.id, name: call.toolName, input: call.input });
      }
      result.push({ role: "assistant", content });
      continue;
    }

    // Tool results are sent back to Claude as a user turn containing a
    // tool_result block, per the Anthropic tool-use protocol.
    result.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: message.toolCallId,
          content: message.content,
        },
      ],
    });
  }

  return result;
}

function fromAnthropicResponse(response: Anthropic.Message): BrainResponse {
  let text = "";
  const toolCalls: ToolCallRequest[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        toolName: block.name,
        input: block.input as Record<string, unknown>,
      });
    }
  }

  return { text, toolCalls, stopReason: response.stop_reason ?? "unknown" };
}
