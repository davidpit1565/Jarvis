/**
 * Shapes returned by the AgentMail REST API (https://docs.agentmail.to),
 * trimmed to only the fields JARVIS actually uses. Field names verified
 * directly against AgentMail's own API reference pages (fetched during
 * this feature's implementation — see AgentMailClient's doc comment for
 * exactly which pages), not guessed.
 */

/** One message summary as returned by GET /v0/inboxes/{inbox_id}/messages. */
export interface AgentMailMessageSummary {
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  subject: string;
  preview: string;
  timestamp: string;
}

/** The full body of one message, as returned by GET /v0/inboxes/{inbox_id}/messages/{message_id}. */
export interface AgentMailMessage extends AgentMailMessageSummary {
  text: string;
  html?: string;
}

/** Result of POST /v0/inboxes/{inbox_id}/messages/send. */
export interface AgentMailSendResult {
  messageId: string;
  threadId: string;
}
