export interface DevicePathValidationResult {
  valid: boolean;
  reason?: string;
}

/**
 * A short defense-in-depth check on Core's side, before a home-relative
 * file path (LIST_DIRECTORY / READ_TEXT_FILE / READ_FILE_BYTES /
 * WRITE_FILE / CREATE_FOLDER) is ever sent to a device. Mirrors the
 * shape of the device agent's own FileAccessPolicy.resolve() (see
 * agents/imac/.../Tools/FileAccessPolicy.swift) without duplicating its
 * actual authority: the Agent's allowlist check against the device's
 * real, symlink-resolved home directory remains the true security
 * boundary (Phase 2's design — see AgentToolRegistry's own doc comment).
 * This just means a malformed or clearly-escaping path (absolute, "..",
 * a null byte) never even reaches the wire, the same value OPEN_URL's
 * urlValidation.ts and CREATE_FOLDER already get.
 */
const ALLOWED_TOP_LEVEL_FOLDERS = ["Desktop", "Documents", "Downloads", "Jarvis"];

export function validateDeviceRelativePath(input: string): DevicePathValidationResult {
  if (typeof input !== "string" || input.trim() === "") {
    return { valid: false, reason: "path must be a non-empty string" };
  }
  if (input.includes("\0")) {
    return { valid: false, reason: "path must not contain a null byte" };
  }
  if (input.startsWith("/") || input.startsWith("~")) {
    return { valid: false, reason: "path must be relative to the home directory, not absolute" };
  }

  const segments = input.split("/");
  if (segments.some((segment) => segment === "..")) {
    return { valid: false, reason: "path must not contain \"..\" segments" };
  }
  const topLevelFolder = segments[0] ?? "";
  if (!ALLOWED_TOP_LEVEL_FOLDERS.includes(topLevelFolder)) {
    return {
      valid: false,
      reason: `path must start inside one of: ${ALLOWED_TOP_LEVEL_FOLDERS.join(", ")}`,
    };
  }

  return { valid: true };
}
