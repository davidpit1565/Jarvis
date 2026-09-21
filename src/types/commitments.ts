export type CommitmentStatus = "open" | "fulfilled" | "stale";

export interface CommitmentRecord {
  id: string;
  /** What JARVIS or the user said would happen, e.g. "follow up about the invoice". */
  text: string;
  /**
   * A loose, human description of when this is expected — "tomorrow",
   * "next week", "after the meeting" — deliberately NOT a precise
   * timestamp. A commitment is a soft follow-up, not a scheduled
   * reminder: if the user wants an exact time, that's CREATE_REMINDER's
   * job instead. Null when no timeframe was mentioned at all.
   */
  dueContext: string | null;
  status: CommitmentStatus;
  createdAt: string;
  /** ISO timestamp the commitment was marked fulfilled at, or null. */
  fulfilledAt: string | null;
}

export interface CreateCommitmentInput {
  text: string;
  dueContext?: string | null;
}
