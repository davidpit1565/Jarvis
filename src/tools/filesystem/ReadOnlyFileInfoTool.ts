import { stat } from "node:fs/promises";
import { PermissionLevel } from "@/types/permissions";
import type { LocalTool, ToolExecutionContext, ToolResult } from "@/types/tools";
import { validateFilePath } from "./pathValidation";

export interface ReadOnlyFileInfoInput extends Record<string, unknown> {
  path: string;
}

export interface FileInfo {
  exists: boolean;
  type?: "file" | "directory" | "other";
  sizeBytes?: number;
}

/**
 * The only tool in Phase 1. Returns non-sensitive metadata about a file
 * without ever reading its contents, writing, or executing anything.
 */
export const readOnlyFileInfoTool: LocalTool<ReadOnlyFileInfoInput> = {
  id: "READ_ONLY_FILE_INFO",
  name: "read_only_file_info",
  description:
    "Returns whether a file exists, its type (file/directory/other), and its size in bytes. " +
    "Never reads file contents and never writes, deletes, or modifies anything.",
  inputSchema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Relative path to inspect, resolved against the JARVIS working directory.",
      },
    },
    required: ["path"],
  },
  requiredPermission: PermissionLevel.READ,
  target: "local",

  async execute(input: ReadOnlyFileInfoInput, _context: ToolExecutionContext): Promise<ToolResult> {
    const validation = validateFilePath(input.path);

    if (!validation.valid || !validation.resolvedPath) {
      return { success: false, error: validation.reason ?? "Invalid path" };
    }

    try {
      const stats = await stat(validation.resolvedPath);
      const info: FileInfo = {
        exists: true,
        type: stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
        sizeBytes: stats.size,
      };
      return { success: true, data: info };
    } catch (error) {
      if (isNodeErrnoException(error) && error.code === "ENOENT") {
        const info: FileInfo = { exists: false };
        return { success: true, data: info };
      }
      return { success: false, error: "Failed to read file metadata" };
    }
  },
};

function isNodeErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
