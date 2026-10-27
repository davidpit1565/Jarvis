import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleDriveClient } from "@/drive/GoogleDriveClient";

export interface SearchDriveFilesInput extends Record<string, unknown> {
  query: string;
  maxResults?: number;
}

/**
 * Searches the user's WHOLE Google Drive (not just files JARVIS itself
 * created) by name or file content, most-recently-modified first — added
 * 2026-10-27 once `drive.readonly` was granted alongside the existing
 * `drive.file` scope (see GoogleCalendarClient's GOOGLE_SCOPES). Use this
 * for a broad "find my X" / "do I have a file about Y" question over
 * David's real Drive; use FIND_DRIVE_FILE instead when he's specifically
 * asking for something JARVIS made (a title match is enough there).
 *
 * READ-only: this only looks files up, never creates/moves/deletes
 * anything.
 */
export function createSearchDriveFilesTool(driveClient: GoogleDriveClient): LocalTool<SearchDriveFilesInput> {
  return {
    id: "SEARCH_DRIVE_FILES",
    name: "search_drive_files",
    description:
      "Searches the user's entire Google Drive (not just files JARVIS created) by name or file content, " +
      "most-recently-modified first. Use this for a broad \"find my X\" / \"do I have a file about Y\" question " +
      "over the user's real Drive.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match against file names or content (a partial/substring match, not exact)." },
        maxResults: { type: "number", description: "Maximum number of files to return. Defaults to 10." },
      },
      required: ["query"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.query !== "string" || input.query.trim() === "") {
        return { success: false, error: "query must be a non-empty string" };
      }
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const files = await driveClient.searchFiles(input.query, maxResults);
        return { success: true, data: { files } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
