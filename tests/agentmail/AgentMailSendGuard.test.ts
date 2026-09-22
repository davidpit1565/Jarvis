import { describe, test, expect } from "bun:test";
import { AgentMailSendGuard } from "@/agentmail/AgentMailSendGuard";

describe("AgentMailSendGuard", () => {
  test("allows sends up to the daily cap, then blocks further ones the same day", () => {
    const guard = new AgentMailSendGuard(2);

    expect(guard.tryConsume("2026-01-01")).toBe(true);
    expect(guard.tryConsume("2026-01-01")).toBe(true);
    expect(guard.tryConsume("2026-01-01")).toBe(false);
  });

  test("resets the count on a new day", () => {
    const guard = new AgentMailSendGuard(1);

    expect(guard.tryConsume("2026-01-01")).toBe(true);
    expect(guard.tryConsume("2026-01-01")).toBe(false);
    expect(guard.tryConsume("2026-01-02")).toBe(true);
  });

  test("remaining() reports how much room is left without consuming", () => {
    const guard = new AgentMailSendGuard(3);

    expect(guard.remaining("2026-01-01")).toBe(3);
    guard.tryConsume("2026-01-01");
    expect(guard.remaining("2026-01-01")).toBe(2);
  });

  test("remaining() never goes negative", () => {
    const guard = new AgentMailSendGuard(1);
    guard.tryConsume("2026-01-01");
    guard.tryConsume("2026-01-01");
    expect(guard.remaining("2026-01-01")).toBe(0);
  });
});
