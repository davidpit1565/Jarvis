/**
 * Typed message contract between JARVIS Core and future device agents
 * (MacBook, iMac, iPhone). No device implements this yet — this only
 * establishes the shape so agents can be built against a stable contract.
 */

export interface ClientCommandMessage {
  type: "command";
  deviceId: string;
  payload: Record<string, unknown>;
}

export interface CoreToolRequestMessage {
  type: "tool_request";
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ClientToolResultMessage {
  type: "tool_result";
  requestId: string;
  result: unknown;
}

export type ClientToCoreMessage = ClientCommandMessage | ClientToolResultMessage;
export type CoreToClientMessage = CoreToolRequestMessage;

export function parseClientMessage(raw: string): ClientToCoreMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }

  const candidate = parsed as { type: unknown };

  if (candidate.type === "command" && isClientCommand(parsed)) {
    return parsed;
  }

  if (candidate.type === "tool_result" && isClientToolResult(parsed)) {
    return parsed;
  }

  return null;
}

function isClientCommand(value: unknown): value is ClientCommandMessage {
  const v = value as Partial<ClientCommandMessage>;
  return typeof v.deviceId === "string" && typeof v.payload === "object" && v.payload !== null;
}

function isClientToolResult(value: unknown): value is ClientToolResultMessage {
  const v = value as Partial<ClientToolResultMessage>;
  return typeof v.requestId === "string" && "result" in v;
}
