import type { Brain } from "@/types/brain";
import type { ToolDefinition, ToolResult } from "@/types/tools";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type {
  AgentPlanRequest,
  AgentPlanner,
  AgentStepProposal,
  AgentVerificationRequest,
  AgentVerificationResult,
} from "./types";

const PLAN_SYSTEM_PROMPT = `You are the planning component of JARVIS's autonomous agent core. Given a goal and a
list of available tools, produce an ordered plan of tool calls that accomplishes the goal.

Respond with ONLY a JSON array (no prose, no markdown fences) of steps, each shaped exactly like:
{"toolName": "<one of the available tool names>", "input": { ... }, "description": "<what this step does and why>"}

Rules:
- Use only tool names from the provided list, with input matching that tool's schema.
- Keep the plan as short as possible while still accomplishing the goal.
- If the goal cannot be accomplished with the available tools, respond with an empty JSON array: []`;

const VERIFY_SYSTEM_PROMPT = `You are the verification component of JARVIS's autonomous agent core. A step just ran
and reported success. Decide whether it actually achieved what it claimed — for example, for a "create X" step,
you might use an available read-only tool to check X actually exists now. Do not just trust that the tool call
didn't throw.

If you need more information before deciding, call at most one read-only verification tool.
Once you have enough information (or don't need a tool call at all), respond with ONLY a JSON object (no prose,
no markdown fences) shaped exactly like:
{"verified": true|false, "reason": "<short explanation>"}`;

/**
 * Real, Brain-backed implementation of AgentPlanner. Kept deliberately
 * separate from AgentCore so AgentCore itself only ever depends on the
 * narrow `AgentPlanner` interface and is unit-testable with a scripted
 * stub — this class is what production code actually wires up.
 */
export class BrainAgentPlanner implements AgentPlanner {
  constructor(
    private readonly brain: Brain,
    private readonly toolRegistry: ToolRegistry
  ) {}

  async plan(request: AgentPlanRequest): Promise<AgentStepProposal[]> {
    const toolList = this.toolRegistry
      .toToolDefinitions()
      .map((tool) => `- ${tool.name}: ${tool.description}\n  input_schema: ${JSON.stringify(tool.input_schema)}`)
      .join("\n");

    const priorFailureNote = request.priorFailure
      ? `\n\nThe previous attempt at this goal failed: ${request.priorFailure}\nProduce a different plan that avoids that failure.`
      : "";

    const completedNote = request.completedSteps.length
      ? `\n\nSteps already completed and verified in a prior attempt (do not repeat these):\n${request.completedSteps
          .map((step) => `- ${step.description} (${step.toolName})`)
          .join("\n")}`
      : "";

    const prompt = `Goal: ${request.goal}\n\nAvailable tools:\n${toolList}${priorFailureNote}${completedNote}`;

    const response = await this.brain.chat({
      messages: [{ role: "user", content: prompt }],
      tools: [],
      context: PLAN_SYSTEM_PROMPT,
    });

    const parsed = extractJson(response.text);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(isStepProposalShaped)
      .map((step) => ({ toolName: step.toolName, input: step.input, description: step.description }));
  }

  async verify(request: AgentVerificationRequest): Promise<AgentVerificationResult> {
    const readOnlyTools = this.readOnlyToolDefinitions();
    const resultSummary = `Step: ${request.step.description}\nTool called: ${request.step.toolName}\nInput: ${JSON.stringify(
      request.step.input
    )}\nReported result: ${JSON.stringify(request.result)}`;

    const first = await this.brain.chat({
      messages: [{ role: "user", content: resultSummary }],
      tools: readOnlyTools,
      context: VERIFY_SYSTEM_PROMPT,
    });

    if (first.toolCalls.length === 0) {
      return parseVerdict(first.text);
    }

    // At most one verification tool call — run it through the Orchestrator
    // pipeline the caller gave us, then ask for a final verdict with that
    // observation in hand.
    const call = first.toolCalls[0];
    if (!call) return parseVerdict(first.text);

    let observation: ToolResult;
    try {
      observation = await request.runVerificationTool(call.toolName, call.input);
    } catch (error) {
      observation = { success: false, error: error instanceof Error ? error.message : "Verification tool call failed" };
    }

    const second = await this.brain.chat({
      messages: [
        { role: "user", content: resultSummary },
        { role: "assistant", content: "", toolCalls: [call] },
        { role: "tool", toolCallId: call.id, toolName: call.toolName, content: JSON.stringify(observation) },
      ],
      tools: [],
      context: VERIFY_SYSTEM_PROMPT,
    });

    return parseVerdict(second.text);
  }

  private readOnlyToolDefinitions(): ToolDefinition[] {
    return this.toolRegistry
      .listTools()
      .filter((tool) => tool.requiredPermission === "READ")
      .map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall back to extracting the first balanced [...] or {...} block, in
    // case the model wrapped its JSON in prose or a markdown fence despite
    // the system prompt telling it not to.
    const match = trimmed.match(/(\[[\s\S]*\]|\{[\s\S]*\})/);
    if (!match) return undefined;
    try {
      return JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
}

function isStepProposalShaped(value: unknown): value is AgentStepProposal {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.toolName === "string" &&
    typeof candidate.description === "string" &&
    typeof candidate.input === "object" &&
    candidate.input !== null
  );
}

/** Fails closed: anything that doesn't parse into a clear "verified: true" is treated as not verified. */
function parseVerdict(text: string): AgentVerificationResult {
  const parsed = extractJson(text);
  if (typeof parsed === "object" && parsed !== null) {
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate.verified === "boolean") {
      return {
        verified: candidate.verified,
        reason: typeof candidate.reason === "string" ? candidate.reason : "No reason given",
      };
    }
  }
  return { verified: false, reason: "Planner returned no parseable verification verdict" };
}
