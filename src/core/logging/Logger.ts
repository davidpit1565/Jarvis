import { randomUUID } from "node:crypto";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

export interface StructuredLogEntry {
  ts: string;
  level: LogLevel;
  scope: string;
  event: string;
  correlationId?: string;
  [key: string]: unknown;
}

/**
 * A fresh per-turn/per-task correlation ID. Use this when no existing ID
 * (an AgentTaskStore/AutomationRuleStore/reminder id, a device-tool
 * `requestId`) already identifies the unit of work — e.g. once per
 * incoming chat turn on a channel that has no other natural id.
 */
export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * A stable, unique id for one error occurrence, safe to surface to a
 * user ("something went wrong, reference errN for support") without
 * leaking the error's actual message/stack. `Logger.error()` stamps one
 * onto every error-level entry automatically and returns it.
 */
export function newErrorId(): string {
  return `err_${randomUUID()}`;
}

export interface LoggerOptions {
  /** Overrides where structured entries are written — tests pass this instead of asserting on real console output. */
  sink?: (entry: StructuredLogEntry) => void;
}

function defaultSink(entry: StructuredLogEntry): void {
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * A small structured (JSON-line) logger — the go-forward pattern for
 * reliability-relevant call sites (schedulers, admin endpoints, backup
 * verification, automation failures), per JARVIS_ROADMAP_AUDIT.md
 * items #169-171. This is deliberately NOT a wholesale replacement for
 * every existing `console.log("[jarvis] ...")` call in the codebase —
 * that would be a large, risky rewrite with little payoff for a
 * single-process personal assistant. New code in this reliability area
 * should use it; existing call sites migrate opportunistically.
 *
 * Every entry carries a `scope` (which subsystem logged it) and,
 * optionally, a `correlationId` that threads one logical unit of work
 * (an agent task, a scheduler tick, a chat turn) across every log line
 * it produces. Get one with `.withCorrelationId(id)` — reuse an
 * existing id (an AgentTaskStore task id, an AutomationRule id) where
 * one already exists, or mint a fresh one with `newCorrelationId()`
 * otherwise. `.error()` additionally stamps a stable `errorId` onto the
 * entry and returns it, so a user-facing error message can reference
 * exactly this log line.
 */
export class Logger {
  private readonly sink: (entry: StructuredLogEntry) => void;

  constructor(
    private readonly scope: string,
    private readonly correlationId?: string,
    options: LoggerOptions = {}
  ) {
    this.sink = options.sink ?? defaultSink;
  }

  /** A copy of this logger bound to a specific correlation id — every entry it writes carries it. */
  withCorrelationId(correlationId: string): Logger {
    return new Logger(this.scope, correlationId, { sink: this.sink });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.write("debug", event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.write("info", event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.write("warn", event, fields);
  }

  /** Logs at error level and stamps+returns a stable error id for this exact occurrence. */
  error(event: string, fields: LogFields = {}): string {
    const errorId = newErrorId();
    this.write("error", event, { ...fields, errorId });
    return errorId;
  }

  private write(level: LogLevel, event: string, fields: LogFields): void {
    const entry: StructuredLogEntry = {
      ts: new Date().toISOString(),
      level,
      scope: this.scope,
      event,
      ...(this.correlationId ? { correlationId: this.correlationId } : {}),
      ...fields,
    };
    this.sink(entry);
  }
}
