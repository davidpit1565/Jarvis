import { describe, test, expect } from "bun:test";
import { Orchestrator } from "@/core/orchestrator/Orchestrator";
import { ConversationManager } from "@/core/conversation/ConversationManager";
import { EventBus } from "@/core/events/EventBus";
import { ToolRegistry } from "@/tools/registry/ToolRegistry";
import { PermissionService } from "@/permissions/PermissionService";
import type { Brain, BrainRequest, BrainResponse } from "@/types/brain";

/**
 * Phase 3 (JARVIS_MASTER_PLAN.md) — context-aware conversation / intent
 * disambiguation. This module is deliberately NOT a new subsystem: the
 * design choice (see the PR this test ships with) is that
 * `ConversationManager.getMessagesForBrain()` already gives the brain
 * everything it needs to resolve "that one" / "continue from where we left
 * off" / a just-answered clarifying question, across realistic multi-turn
 * exchanges — so the actual fix is system-prompt guidance
 * (`JARVIS_SYSTEM_PROMPT`), not a second, parallel short-term-memory
 * mechanism. These tests exercise the real Orchestrator + ConversationManager
 * pipeline against a scripted brain to prove that claim, rather than assuming
 * it: each scenario inspects the exact `BrainRequest.messages` a later turn
 * actually receives.
 */

/** Scripted mock brain that also records every request it was called with, for asserting on conversation history. */
class RecordingScriptedBrain implements Brain {
  public requests: BrainRequest[] = [];
  private calls = 0;
  constructor(private readonly responses: BrainResponse[]) {}

  async chat(request: BrainRequest): Promise<BrainResponse> {
    this.requests.push(request);
    const response = this.responses[this.calls];
    this.calls++;
    if (!response) throw new Error("RecordingScriptedBrain ran out of scripted responses");
    return response;
  }
}

function setup(brain: Brain) {
  const eventBus = new EventBus();
  const toolRegistry = new ToolRegistry();
  const permissionService = new PermissionService();
  const conversation = new ConversationManager(eventBus);
  const orchestrator = new Orchestrator({ brain, conversation, toolRegistry, permissionService, eventBus });
  return { orchestrator, conversation };
}

const reply = (text: string): BrainResponse => ({ text, toolCalls: [], stopReason: "end_turn" });

describe("context-aware conversation (Phase 3)", () => {
  test("a clarifying question's answer is visible to the very next turn's brain call", async () => {
    // Scenario: "What do I have to do today?" is genuinely ambiguous (work vs.
    // school vs. personal projects) — the brain asks ONE clarifying question,
    // the user answers, and the next turn must be able to see that answer
    // without JARVIS re-asking. This only requires that the answer actually
    // reaches the next brain.chat() call — it does, because ConversationManager
    // records every turn and getMessagesForBrain() keeps the most recent turns
    // verbatim.
    const brain = new RecordingScriptedBrain([
      reply("Work, school, or your personal projects, sir?"),
      reply("Right — you have two things due for BFA coursework this week, sir."),
    ]);
    const { orchestrator } = setup(brain);

    const first = await orchestrator.handleUserMessage("david", "What do I have to do today?");
    expect(first).toMatch(/work, school, or your personal projects/i);

    await orchestrator.handleUserMessage("david", "School");

    // The second brain.chat() call must see both the original question AND
    // the user's disambiguating answer, so the model can resolve "school"
    // against "what do I have to do today" without the Orchestrator needing
    // any bespoke "last question asked" state of its own.
    const secondRequestText = JSON.stringify(brain.requests[1]!.messages);
    expect(secondRequestText).toContain("What do I have to do today?");
    expect(secondRequestText).toContain("Work, school, or your personal projects");
    expect(secondRequestText).toContain("School");
  });

  test("'continue from where we left off' resolves against real prior turns, several messages later", async () => {
    // Scenario: the user discusses a specific project, moves on to something
    // else, then says "continue from where we left off" a few turns later.
    // Within ConversationManager's verbatim window (last 6 turns), the brain
    // sees the original project discussion verbatim — no separate "what did
    // we just disambiguate" tracker is needed for this short a gap.
    const brain = new RecordingScriptedBrain([
      reply("Rudder's Backend currently deploys to Vercel, sir."),
      reply("Understood."),
      reply("Picking back up on Rudder's Backend, sir — want me to look at the Vercel migration next?"),
    ]);
    const { orchestrator } = setup(brain);

    await orchestrator.handleUserMessage("david", "What's the deployment status of Rudder's Backend?");
    await orchestrator.handleUserMessage("david", "Not now, remind me later.");
    const third = await orchestrator.handleUserMessage("david", "Ok, continue from where we left off.");

    expect(third).toMatch(/rudder/i);
    const thirdRequestText = JSON.stringify(brain.requests[2]!.messages);
    expect(thirdRequestText).toContain("Rudder's Backend");
    expect(thirdRequestText).toContain("continue from where we left off");
  });

  test("an already-answered clarification is not re-sent as a repeat question by JARVIS itself", async () => {
    // This asserts on Orchestrator/ConversationManager behavior only (never
    // re-asking is the system prompt's job, which systemPrompt.test.ts
    // covers) — specifically, that conversation history accumulates rather
    // than resets between turns, which is the precondition the system-prompt
    // instruction relies on to avoid re-asking.
    const brain = new RecordingScriptedBrain([
      reply("Work, school, or personal projects, sir?"),
      reply("You have one task due for your software projects, sir."),
      reply("Also one more due for your software projects by Friday, sir."),
    ]);
    const { orchestrator, conversation } = setup(brain);

    await orchestrator.handleUserMessage("david", "What do I have to do today?");
    await orchestrator.handleUserMessage("david", "Projects");
    await orchestrator.handleUserMessage("david", "Anything else?");

    // By the third turn, conversation history still contains the original
    // disambiguation exchange (not dropped/reset), which is what lets the
    // model avoid asking "work, school, or projects?" a second time.
    const allMessages = conversation.getMessages();
    const flatText = JSON.stringify(allMessages);
    expect(flatText).toContain("Work, school, or personal projects");
    expect(flatText).toContain("Projects");
    expect(allMessages.length).toBeGreaterThan(4);
  });
});
