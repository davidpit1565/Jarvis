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

/**
 * The export formats this client supports (POST /v1/exports -> GET
 * /v1/exports/{exportId}). Canva's API also supports gif/mp4/csv/
 * html_bundle/html_standalone — deliberately left out of v1 (see
 * CanvaClient.exportDesign's own doc comment for why).
 */
export type CanvaExportFormat = "pdf" | "png" | "jpg" | "pptx";

/**
 * The result of a successful export job. `urls` holds one download URL per
 * exported page (sorted by page order) per Canva's own docs — usually one
 * entry, more for a multi-page PNG/JPG export. Canva's download URLs
 * expire 24 hours after the job completes, so this is never persisted —
 * only handed back for immediate use (e.g. delivering straight to
 * Telegram, which fetches it right away).
 */
export interface CanvaExport {
  id: string;
  format: CanvaExportFormat;
  urls: string[];
}
