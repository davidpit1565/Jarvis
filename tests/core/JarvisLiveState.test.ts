import { describe, test, expect } from "bun:test";
import { EventBus } from "@/core/events/EventBus";
import {
  JarvisLiveStateTracker,
  InvalidLiveStateTransitionError,
  canTransitionLiveState,
  liveStateForAgentTaskState,
  type LiveState,
} from "@/core/state/JarvisLiveState";

describe("JarvisLiveState transition table", () => {
  test("legal happy-path chat turn", () => {
    const sequence: LiveState[] = ["IDLE", "LISTENING", "THINKING", "EXECUTING", "THINKING", "SPEAKING", "IDLE"];
    for (let i = 0; i < sequence.length - 1; i++) {
      expect(canTransitionLiveState(sequence[i]!, sequence[i + 1]!)).toBe(true);
    }
  });

  test("legal agent-task path", () => {
    const sequence: LiveState[] = ["IDLE", "PLANNING", "EXECUTING", "VERIFYING", "EXECUTING", "SPEAKING", "IDLE"];
    for (let i = 0; i < sequence.length - 1; i++) {
      expect(canTransitionLiveState(sequence[i]!, sequence[i + 1]!)).toBe(true);
    }
  });

  test("ERROR and STOPPED are reachable from every active state", () => {
    const active: LiveState[] = ["LISTENING", "THINKING", "PLANNING", "EXECUTING", "VERIFYING", "WAITING", "SPEAKING"];
    for (const state of active) {
      expect(canTransitionLiveState(state, "ERROR")).toBe(true);
      expect(canTransitionLiveState(state, "STOPPED")).toBe(true);
    }
  });

  test("ERROR and STOPPED are terminal-ish: only IDLE is legal from them", () => {
    expect(canTransitionLiveState("ERROR", "IDLE")).toBe(true);
    expect(canTransitionLiveState("ERROR", "THINKING")).toBe(false);
    expect(canTransitionLiveState("STOPPED", "IDLE")).toBe(true);
    expect(canTransitionLiveState("STOPPED", "LISTENING")).toBe(false);
  });

  test("illegal transitions are rejected", () => {
    expect(canTransitionLiveState("IDLE", "SPEAKING")).toBe(false);
    expect(canTransitionLiveState("IDLE", "VERIFYING")).toBe(false);
    expect(canTransitionLiveState("SPEAKING", "EXECUTING")).toBe(false);
  });
});

describe("JarvisLiveStateTracker", () => {
  test("an unseen session defaults to IDLE without creating a stored snapshot", () => {
    const tracker = new JarvisLiveStateTracker();
    expect(tracker.getState("chat:alice")).toBe("IDLE");
    expect(tracker.listSessions()).toHaveLength(0);
  });

  test("legal transitions update the snapshot", () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "LISTENING");
    tracker.transition("chat:alice", "alice", "THINKING");
    const snapshot = tracker.getSnapshot("chat:alice", "alice");
    expect(snapshot.state).toBe("THINKING");
    expect(snapshot.userId).toBe("alice");
  });

  test("illegal transitions throw InvalidLiveStateTransitionError and leave state unchanged", () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "LISTENING");
    expect(() => tracker.transition("chat:alice", "alice", "SPEAKING")).toThrow(InvalidLiveStateTransitionError);
    expect(tracker.getState("chat:alice")).toBe("LISTENING");
  });

  test("same-state transitions are always legal and still update the timestamp", async () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "THINKING");
    tracker.transition("chat:alice", "alice", "EXECUTING");
    const first = tracker.getSnapshot("chat:alice", "alice").updatedAt;
    await new Promise((resolve) => setTimeout(resolve, 2));
    tracker.transition("chat:alice", "alice", "EXECUTING", { reason: "another tool call" });
    const second = tracker.getSnapshot("chat:alice", "alice").updatedAt;
    expect(second).toBeGreaterThanOrEqual(first);
  });

  test("two sessions for different channels/users are fully isolated", () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "LISTENING");
    tracker.transition("telegram:bob", "bob", "THINKING");

    expect(tracker.getState("chat:alice")).toBe("LISTENING");
    expect(tracker.getState("telegram:bob")).toBe("THINKING");

    tracker.transition("chat:alice", "alice", "THINKING");
    // bob's session must be untouched by alice's transition.
    expect(tracker.getState("telegram:bob")).toBe("THINKING");
    expect(tracker.getState("chat:alice")).toBe("THINKING");
  });

  test("the same userId on two different channels does not collide", () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "LISTENING");
    tracker.transition("phone:alice", "alice", "THINKING");
    tracker.transition("phone:alice", "alice", "EXECUTING");

    expect(tracker.getState("chat:alice")).toBe("LISTENING");
    expect(tracker.getState("phone:alice")).toBe("EXECUTING");
  });

  test("every transition emits jarvis.liveState.changed on the EventBus", () => {
    const eventBus = new EventBus();
    const tracker = new JarvisLiveStateTracker(eventBus);
    const events: Array<{ from: string; to: string }> = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      events.push({ from: payload.from, to: payload.to });
    });

    tracker.transition("chat:alice", "alice", "LISTENING", { reason: "message received" });
    tracker.transition("chat:alice", "alice", "THINKING");

    expect(events).toEqual([
      { from: "IDLE", to: "LISTENING" },
      { from: "LISTENING", to: "THINKING" },
    ]);
  });

  test("event payload carries sessionId, userId, reason, language and timestamp", () => {
    const eventBus = new EventBus();
    const tracker = new JarvisLiveStateTracker(eventBus);
    let captured: unknown;
    eventBus.on("jarvis.liveState.changed", (payload) => {
      captured = payload;
    });

    tracker.transition("chat:alice", "alice", "LISTENING", { reason: "message received", language: "he" });

    expect(captured).toMatchObject({
      sessionId: "chat:alice",
      userId: "alice",
      from: "IDLE",
      to: "LISTENING",
      reason: "message received",
      language: "he",
    });
    expect(typeof (captured as { timestamp: number }).timestamp).toBe("number");
  });

  test("setLanguage updates the snapshot's language without changing state, and still emits", () => {
    const eventBus = new EventBus();
    const tracker = new JarvisLiveStateTracker(eventBus);
    const events: Array<{ from: string; to: string; language?: string }> = [];
    eventBus.on("jarvis.liveState.changed", (payload) => {
      events.push({ from: payload.from, to: payload.to, language: payload.language });
    });

    tracker.transition("chat:alice", "alice", "THINKING");
    tracker.setLanguage("chat:alice", "alice", "he");

    const snapshot = tracker.getSnapshot("chat:alice", "alice");
    expect(snapshot.state).toBe("THINKING");
    expect(snapshot.language).toBe("he");
    expect(events.at(-1)).toEqual({ from: "THINKING", to: "THINKING", language: "he" });
  });

  test("language set once persists across subsequent transitions that don't specify it", () => {
    const tracker = new JarvisLiveStateTracker();
    tracker.transition("chat:alice", "alice", "LISTENING");
    tracker.setLanguage("chat:alice", "alice", "en");
    tracker.transition("chat:alice", "alice", "THINKING");
    expect(tracker.getSnapshot("chat:alice", "alice").language).toBe("en");
  });

  describe("requestStop / isStopRequested / reset", () => {
    test("requestStop transitions an active session straight to STOPPED and sets the flag", () => {
      const tracker = new JarvisLiveStateTracker();
      tracker.transition("chat:alice", "alice", "THINKING");
      tracker.transition("chat:alice", "alice", "EXECUTING");
      const result = tracker.requestStop("chat:alice", "alice");
      expect(result).toBeDefined();
      expect(tracker.getState("chat:alice")).toBe("STOPPED");
      expect(tracker.isStopRequested("chat:alice")).toBe(true);
    });

    test("requestStop on an IDLE/no-op session returns undefined and changes nothing", () => {
      const tracker = new JarvisLiveStateTracker();
      const result = tracker.requestStop("chat:alice", "alice");
      expect(result).toBeUndefined();
      expect(tracker.getState("chat:alice")).toBe("IDLE");
    });

    test("reset clears STOPPED back to IDLE and clears the flag", () => {
      const tracker = new JarvisLiveStateTracker();
      tracker.transition("chat:alice", "alice", "THINKING");
      tracker.requestStop("chat:alice", "alice");
      expect(tracker.isStopRequested("chat:alice")).toBe(true);

      tracker.reset("chat:alice", "alice");
      expect(tracker.getState("chat:alice")).toBe("IDLE");
      expect(tracker.isStopRequested("chat:alice")).toBe(false);
    });

    test("requestStop on one session never affects another session's stop flag", () => {
      const tracker = new JarvisLiveStateTracker();
      tracker.transition("chat:alice", "alice", "THINKING");
      tracker.transition("chat:alice", "alice", "EXECUTING");
      tracker.transition("chat:bob", "bob", "THINKING");
      tracker.transition("chat:bob", "bob", "EXECUTING");

      tracker.requestStop("chat:alice", "alice");

      expect(tracker.isStopRequested("chat:alice")).toBe(true);
      expect(tracker.isStopRequested("chat:bob")).toBe(false);
      expect(tracker.getState("chat:bob")).toBe("EXECUTING");
    });
  });
});

describe("liveStateForAgentTaskState", () => {
  test("maps every AgentTaskState to its live-state equivalent (or undefined for PENDING)", () => {
    expect(liveStateForAgentTaskState("PENDING")).toBeUndefined();
    expect(liveStateForAgentTaskState("PLANNING")).toBe("PLANNING");
    expect(liveStateForAgentTaskState("EXECUTING")).toBe("EXECUTING");
    expect(liveStateForAgentTaskState("VERIFYING")).toBe("VERIFYING");
    expect(liveStateForAgentTaskState("RETRYING")).toBe("EXECUTING");
    expect(liveStateForAgentTaskState("RECOVERING")).toBe("PLANNING");
    expect(liveStateForAgentTaskState("WAITING")).toBe("WAITING");
    expect(liveStateForAgentTaskState("COMPLETED")).toBe("SPEAKING");
    expect(liveStateForAgentTaskState("FAILED")).toBe("ERROR");
    expect(liveStateForAgentTaskState("CANCELLED")).toBe("STOPPED");
  });
});
