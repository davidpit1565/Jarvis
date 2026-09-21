import { describe, test, expect } from "bun:test";
import { Logger, newCorrelationId, newErrorId, type StructuredLogEntry } from "@/core/logging/Logger";

function captureLogger(scope = "test", correlationId?: string) {
  const entries: StructuredLogEntry[] = [];
  const logger = new Logger(scope, correlationId, { sink: (entry) => entries.push(entry) });
  return { logger, entries };
}

describe("Logger", () => {
  test("writes structured entries with ts/level/scope/event", () => {
    const { logger, entries } = captureLogger("scheduler");
    logger.info("tick", { name: "wakeUpCalls" });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("info");
    expect(entries[0]!.scope).toBe("scheduler");
    expect(entries[0]!.event).toBe("tick");
    expect(entries[0]!.name).toBe("wakeUpCalls");
    expect(typeof entries[0]!.ts).toBe("string");
    expect(new Date(entries[0]!.ts).toString()).not.toBe("Invalid Date");
  });

  test("omits correlationId when none is set", () => {
    const { logger, entries } = captureLogger();
    logger.info("event");
    expect(entries[0]!.correlationId).toBeUndefined();
  });

  test("withCorrelationId threads the same id through every entry it writes", () => {
    const { logger, entries } = captureLogger("automation");
    const scoped = logger.withCorrelationId("rule-123");
    scoped.info("started");
    scoped.warn("slow");

    expect(entries).toHaveLength(2);
    expect(entries[0]!.correlationId).toBe("rule-123");
    expect(entries[1]!.correlationId).toBe("rule-123");
  });

  test("withCorrelationId does not mutate the original logger", () => {
    const { logger, entries } = captureLogger();
    logger.withCorrelationId("abc").info("scoped");
    logger.info("unscoped");

    expect(entries[0]!.correlationId).toBe("abc");
    expect(entries[1]!.correlationId).toBeUndefined();
  });

  test("error() stamps a stable errorId onto the entry and returns it", () => {
    const { logger, entries } = captureLogger();
    const errorId = logger.error("db_write_failed", { detail: "disk full" });

    expect(entries).toHaveLength(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.errorId).toBe(errorId);
    expect(entries[0]!.detail).toBe("disk full");
    expect(errorId.startsWith("err_")).toBe(true);
  });

  test("error() returns a distinct id on every call", () => {
    const { logger } = captureLogger();
    const first = logger.error("failure-one");
    const second = logger.error("failure-two");
    expect(first).not.toBe(second);
  });

  test("newCorrelationId returns distinct UUID-shaped values", () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("newErrorId is prefixed and unique", () => {
    const a = newErrorId();
    const b = newErrorId();
    expect(a).not.toBe(b);
    expect(a.startsWith("err_")).toBe(true);
  });
});
