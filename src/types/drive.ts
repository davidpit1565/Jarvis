/** A file JARVIS created in (or found in) the user's Google Drive — presentations and documents are Drive files too, addressed by the same id space as their own Slides/Docs API ids. */
export interface DriveFile {
  id: string;
  name: string;
  /** The URL to open this file in its native Google Drive web editor — what gets handed back to the user so they can actually open what was created. */
  webViewLink: string;
  mimeType: string;
  /** Which linked Google account (its email) this file belongs to. */
  account: string;
}

/** A simple, LLM-friendly outline for a presentation — deterministic code (GoogleSlidesClient) turns this into the actual Slides API batchUpdate requests, so the model never has to produce raw Slides API JSON itself. */
export interface PresentationOutline {
  title: string;
  slides: Array<{
    title: string;
    bullets: string[];
  }>;
}
