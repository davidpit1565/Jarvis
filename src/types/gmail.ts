export interface EmailSummary {
  id: string;
  subject: string;
  from: string;
  date: string;
  snippet: string;
  /** Which linked Google account (its email) this message belongs to — lets a multi-account aggregated result say "in your personal account". */
  account: string;
}
