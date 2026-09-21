import { describe, test, expect } from "bun:test";
import {
  AGENT_TASK_STATES,
  AGENT_TASK_TERMINAL_STATES,
  InvalidAgentTaskTransitionError,
  assertValidTransition,
  canTransition,
  isTerminalState,
  type AgentTaskState,
} from "@/agent/AgentTaskStateMachine";

describe("AgentTaskStateMachine", () => {
  test("allows the documented happy path", () => {
    const path: AgentTaskState[] = ["PENDING", "PLANNING", "EXECUTING", "VERIFYING", "COMPLETED"];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  test("allows RETRYING -> EXECUTING", () => {
    expect(canTransition("EXECUTING", "RETRYING")).toBe(true);
    expect(canTransition("RETRYING", "EXECUTING")).toBe(true);
  });

  test("allows RECOVERING -> PLANNING", () => {
    expect(canTransition("EXECUTING", "RECOVERING")).toBe(true);
    expect(canTransition("VERIFYING", "RECOVERING")).toBe(true);
    expect(canTransition("RECOVERING", "PLANNING")).toBe(true);
  });

  test("allows cancellation from every non-terminal state", () => {
    for (const state of AGENT_TASK_STATES) {
      if (AGENT_TASK_TERMINAL_STATES.has(state)) continue;
      expect(canTransition(state, "CANCELLED")).toBe(true);
    }
  });

  test("rejects an illegal transition, e.g. PENDING straight to COMPLETED", () => {
    expect(canTransition("PENDING", "COMPLETED")).toBe(false);
    expect(() => assertValidTransition("PENDING", "COMPLETED")).toThrow(InvalidAgentTaskTransitionError);
  });

  test("rejects skipping PLANNING entirely", () => {
    expect(canTransition("PENDING", "EXECUTING")).toBe(false);
  });

  test("every terminal state has no outgoing transitions", () => {
    for (const terminal of AGENT_TASK_TERMINAL_STATES) {
      for (const other of AGENT_TASK_STATES) {
        expect(canTransition(terminal, other)).toBe(false);
      }
      expect(isTerminalState(terminal)).toBe(true);
    }
  });

  test("non-terminal states are not reported as terminal", () => {
    expect(isTerminalState("EXECUTING")).toBe(false);
    expect(isTerminalState("PENDING")).toBe(false);
  });

  test("InvalidAgentTaskTransitionError carries the offending from/to", () => {
    try {
      assertValidTransition("COMPLETED", "EXECUTING");
      throw new Error("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidAgentTaskTransitionError);
      const typed = error as InvalidAgentTaskTransitionError;
      expect(typed.from).toBe("COMPLETED");
      expect(typed.to).toBe("EXECUTING");
      expect(typed.message).toContain("COMPLETED -> EXECUTING");
    }
  });

  test("WAITING can resume execution or verification, or terminate", () => {
    expect(canTransition("WAITING", "EXECUTING")).toBe(true);
    expect(canTransition("WAITING", "VERIFYING")).toBe(true);
    expect(canTransition("WAITING", "FAILED")).toBe(true);
    expect(canTransition("WAITING", "CANCELLED")).toBe(true);
  });
});
