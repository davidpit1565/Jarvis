import { resolve, sep } from "node:path";

export interface PathValidationResult {
  valid: boolean;
  reason?: string;
  resolvedPath?: string;
}

const SENSITIVE_SEGMENT_PATTERNS = [
  /\.ssh(\/|$)/i,
  /\.env(\.|$)/i,
  /id_rsa/i,
  /\.pem$/i,
  /\.key$/i,
  /credentials/i,
  /\.aws(\/|$)/i,
  /\.gnupg(\/|$)/i,
  /shadow$/i,
  /passwd$/i,
];

const SENSITIVE_ABSOLUTE_PREFIXES = ["/etc", "/root", "/proc", "/sys", "/boot", "/dev"];

/**
 * Validates a user/Claude-supplied file path before any filesystem access.
 * Confines lookups to `allowedRoot` and blocks well-known sensitive
 * locations and traversal tricks. This is intentionally conservative:
 * Phase 1 only needs read-only metadata, not general file access.
 */
export function validateFilePath(
  inputPath: string,
  allowedRoot: string = process.cwd()
): PathValidationResult {
  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    return { valid: false, reason: "Path must be a non-empty string" };
  }

  if (inputPath.includes("\0")) {
    return { valid: false, reason: "Path contains a null byte" };
  }

  const resolvedAllowedRoot = resolve(allowedRoot);
  const resolvedPath = resolve(resolvedAllowedRoot, inputPath);

  const isWithinRoot =
    resolvedPath === resolvedAllowedRoot || resolvedPath.startsWith(resolvedAllowedRoot + sep);

  if (!isWithinRoot) {
    return { valid: false, reason: "Path escapes the allowed root directory" };
  }

  for (const prefix of SENSITIVE_ABSOLUTE_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + sep)) {
      return { valid: false, reason: "Path targets a sensitive system location" };
    }
  }

  for (const pattern of SENSITIVE_SEGMENT_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      return { valid: false, reason: "Path matches a sensitive file pattern" };
    }
  }

  return { valid: true, resolvedPath };
}
