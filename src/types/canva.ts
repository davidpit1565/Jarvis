/** A design listed from the user's Canva "Projects" (GET /v1/designs). */
export interface CanvaDesignSummary {
  id: string;
  title: string | null;
  /** Temporary (30-day) editing URL — Canva's own, not a permanent link. */
  editUrl: string;
  /** Temporary (30-day) viewing URL — Canva's own, not a permanent link. */
  viewUrl: string;
  updatedAt: number;
  designTypes: string[];
}

/** A brand template the user has access to (GET /v1/brand-templates) — the only realistic source for Autofill in v1 (see CanvaClient's own doc comment). */
export interface CanvaBrandTemplate {
  id: string;
  title: string;
  viewUrl: string;
  createUrl: string;
}

/** The design produced by a successful autofill job (POST /v1/autofills -> GET /v1/autofills/{jobId}). */
export interface CanvaCreatedDesign {
  id: string;
  title: string | null;
  /** Permanent-looking canva.com/design/... URL, when Canva's response includes one. */
  url: string | null;
  editUrl: string;
  viewUrl: string;
}
