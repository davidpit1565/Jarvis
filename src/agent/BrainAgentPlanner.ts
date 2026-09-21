import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";
import type { ToolDefinition, ToolResult } from "@/types/tools";
import type { ToolRegistry } from "@/tools/registry/ToolRegistry";
import type {
  AgentPlanRequest,
  AgentPlanner,
  AgentStepProposal,
  AgentVerificationRequest,
  AgentVerificationResult,
} from "./types";

/**
 * Model Escalation's narrow optional extension of `Brain` — see
 * `AIRouter.chatWithEscalation`'s own doc comment for the full contract
 * (deterministic validation only, capped at one retry, respects
 * ZERO_COST_MODE). Checked with `supportsEscalation` below rather than
 * added to the base `Brain` interface, so every other `Brain`
 * implementation (ClaudeBrain, GroqBrain, a test stub) needs no changes.
 */
interface EscalatingBrain extends Brain {
  chatWithEscalation(request: BrainRequest, isValid: (response: BrainResponse) => boolean): Promise<BrainResponse>;
}

function supportsEscalation(brain: Brain): brain is EscalatingBrain {
  return typeof (brain as Partial<EscalatingBrain>).chatWithEscalation === "function";
}

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
    const chatRequest: BrainRequest = {
      messages: [{ role: "user", content: prompt }],
      tools: [],
      context: PLAN_SYSTEM_PROMPT,
      runId: request.taskId,
      taskType: "agent-plan",
    };

    // Model Escalation: a plan response that doesn't parse into a JSON
    // array at all (malformed/empty, not a legitimately-empty `[]` plan —
    // see `isParsablePlanResponse`) is exactly the deterministic,
    // schema-validation-failure signal the roadmap's escalation feature
    // targets. One retry against a stronger allowed model (never an
    // unbounded loop, never a paid model under ZERO_COST_MODE — see
    // `AIRouter.chatWithEscalation`), then whatever comes back (better or
    // not) is used as-is.
    const response = supportsEscalation(this.brain)
      ? await this.brain.chatWithEscalation(chatRequest, isParsablePlanResponse)
      : await this.brain.chat(chatRequest);

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
      runId: request.taskId,
      taskType: "agent-verify",
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
      runId: request.taskId,
      taskType: "agent-verify",
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

/**
 * Deterministic validity check for Model Escalation — true only if
 * `response.text` parses into a JSON array (an intentionally-empty `[]`
 * "goal can't be accomplished" plan still counts as valid; only a
 * response that fails to parse into an array at all — prose, a fenced
 * non-JSON block, truncated/malformed JSON, an empty string — counts as
 * invalid and triggers one escalation retry).
 */
function isParsablePlanResponse(response: BrainResponse): boolean {
  return Array.isArray(extractJson(response.text));
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
