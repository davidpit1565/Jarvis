import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { GoogleDriveClient } from "@/drive/GoogleDriveClient";

export interface FindDriveFileInput extends Record<string, unknown> {
  name: string;
  maxResults?: number;
}

/**
 * Lets Claude resolve a follow-up like "open the presentation I made
 * yesterday" or "find that checklist" back to a real file — without this,
 * CREATE_PRESENTATION/CREATE_CHECKLIST's own result (returned once, in that
 * turn) would be the only way to ever get a file's link again. READ-only:
 * this only looks files up, never creates/moves/deletes anything. Scoped by
 * the drive.file OAuth scope to files JARVIS itself created (or the user
 * explicitly opened with it) — never the rest of the user's Drive.
 */
export function createFindDriveFileTool(driveClient: GoogleDriveClient): LocalTool<FindDriveFileInput> {
  return {
    id: "FIND_DRIVE_FILE",
    name: "find_drive_file",
    description:
      "Finds files JARVIS has created in the user's Google Drive (presentations, checklists/docs) by a " +
      "name match, most-recently-modified first. Use this to resolve a follow-up reference like \"open the " +
      'presentation I made yesterday" or "find that checklist" back to a real file and its link.',
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Text to match against file names (a partial/substring match, not exact)." },
        maxResults: { type: "number", description: "Maximum number of files to return. Defaults to 10." },
      },
      required: ["name"],
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      if (typeof input.name !== "string" || input.name.trim() === "") {
        return { success: false, error: "name must be a non-empty string" };
      }
      const maxResults = typeof input.maxResults === "number" ? input.maxResults : undefined;
      if (maxResults !== undefined && (!Number.isInteger(maxResults) || maxResults <= 0)) {
        return { success: false, error: "maxResults must be a positive integer" };
      }

      try {
        const files = await driveClient.findFilesByName(input.name, maxResults);
        return { success: true, data: { files } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
