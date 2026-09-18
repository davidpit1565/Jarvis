import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const SCAN_DIRS = ["src", "agents"];
const SCANNED_EXTENSIONS = new Set([".ts", ".swift"]);

/**
 * Reviewed, known-safe exceptions — a fixed invocation with no
 * model-controlled or user-controlled input, never a path to running
 * arbitrary commands. Each entry must name the exact file and pattern it
 * excuses, so a *new* match anywhere else (or a new pattern in the same
 * file) still fails the test.
 */
const ALLOWED_EXCEPTIONS: Array<{ file: string; patternName: string }> = [
  {
    // Backs up a fixed list of this project's own SQLite file paths via
    // `tar` for GET /backup — an array of args, no shell, no user input,
    // and no relation to the model/tool layer at all.
    file: "src/backup/createBackupArchive.ts",
    patternName: "Bun.spawn",
  },
];

/**
 * Patterns that would mean "JARVIS can run an arbitrary command/script,"
 * the one thing this project's own security model (see
 * agents/imac/JarvisAgent/Sources/JarvisAgent/Tools/ToolRegistry.swift's
 * own comment on this) says must never exist — every device capability is
 * a named, compiled-in function, never an interpreter for arbitrary
 * instructions. Real regexes, not substring checks, so legitimate uses of
 * words like "execute" (a method every tool already has) don't false-positive.
 */
const FORBIDDEN_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "node:child_process", pattern: /\bchild_process\b/ },
  { name: "Bun.spawn", pattern: /\bBun\.spawn(Sync)?\b/ },
  { name: "execSync/exec()", pattern: /\bexecSync\s*\(|\bexeca\s*\(/ },
  { name: "NSAppleScript", pattern: /\bNSAppleScript\b/ },
  { name: "osascript", pattern: /\bosascript\b/ },
  { name: "raw shell path", pattern: /\/bin\/(sh|bash|zsh)\b/ },
  { name: "Swift Process() invocation", pattern: /\bProcess\(\)/ },
];

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name.startsWith(".build")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (SCANNED_EXTENSIONS.has(extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Security: no arbitrary command/script execution anywhere in Core or the Agent", () => {
  test("no source file matches a forbidden execution pattern", () => {
    const violations: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const filePath of listFilesRecursive(join(REPO_ROOT, dir))) {
        const content = readFileSync(filePath, "utf8");
        const relativePath = filePath.replace(REPO_ROOT + "/", "");
        for (const { name, pattern } of FORBIDDEN_PATTERNS) {
          const isAllowed = ALLOWED_EXCEPTIONS.some((e) => e.file === relativePath && e.patternName === name);
          if (pattern.test(content) && !isAllowed) {
            violations.push(`${relativePath}: matches "${name}"`);
          }
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
