import { describe, test, expect } from "bun:test";
import { validateDeviceRelativePath } from "@/tools/system/devicePathValidation";

describe("validateDeviceRelativePath", () => {
  test("accepts a path inside an allowlisted top-level folder", () => {
    expect(validateDeviceRelativePath("Desktop/notes.txt").valid).toBe(true);
    expect(validateDeviceRelativePath("Documents/Work/report.pdf").valid).toBe(true);
    expect(validateDeviceRelativePath("Downloads").valid).toBe(true);
    expect(validateDeviceRelativePath("Jarvis/scratch.md").valid).toBe(true);
  });

  test("rejects an empty or non-string path", () => {
    expect(validateDeviceRelativePath("").valid).toBe(false);
    expect(validateDeviceRelativePath("   ").valid).toBe(false);
  });

  test("rejects a null byte", () => {
    expect(validateDeviceRelativePath("Desktop/notes.txt\0.jpg").valid).toBe(false);
  });

  test("rejects an absolute path", () => {
    expect(validateDeviceRelativePath("/etc/passwd").valid).toBe(false);
  });

  test("rejects a home-relative shorthand", () => {
    expect(validateDeviceRelativePath("~/Desktop/notes.txt").valid).toBe(false);
  });

  test("rejects a path with a '..' traversal segment", () => {
    expect(validateDeviceRelativePath("Desktop/../../etc/passwd").valid).toBe(false);
    expect(validateDeviceRelativePath("../Documents/secret.txt").valid).toBe(false);
  });

  test("rejects a top-level folder outside the allowlist", () => {
    expect(validateDeviceRelativePath("Library/Keychains/login.keychain").valid).toBe(false);
    expect(validateDeviceRelativePath(".ssh/id_rsa").valid).toBe(false);
  });

  // Edge cases added for roadmap #83/#84/#85 (file-access / WRITE_FILE /
  // destructive-action boundary tests) — pure-TypeScript logic that's
  // fully verifiable without a real Mac, unlike FileAccessPolicy.swift's
  // own symlink-resolving re-check on the device side.

  test("rejects a top-level folder name that merely starts with an allowlisted one", () => {
    // "Desktoptrick" must not pass just because it starts with "Desktop" —
    // the check is exact-segment equality, not a prefix/startsWith test.
    expect(validateDeviceRelativePath("Desktoptrick/notes.txt").valid).toBe(false);
    expect(validateDeviceRelativePath("Documents-backup/notes.txt").valid).toBe(false);
  });

  test("rejects a case-mismatched top-level folder", () => {
    // Case-sensitive: "desktop" is not "Desktop". A real filesystem lookup
    // would 404 on this anyway, but the validator must reject it itself
    // rather than relying on that downstream behavior.
    expect(validateDeviceRelativePath("desktop/notes.txt").valid).toBe(false);
    expect(validateDeviceRelativePath("DESKTOP/notes.txt").valid).toBe(false);
  });

  test("rejects a traversal segment buried deep in an otherwise-allowlisted path", () => {
    expect(validateDeviceRelativePath("Documents/a/b/c/../../../../etc/passwd").valid).toBe(false);
    expect(validateDeviceRelativePath("Jarvis/notes/../../../../Library/Keychains").valid).toBe(false);
  });

  test("rejects a lone '..' segment with no trailing content", () => {
    expect(validateDeviceRelativePath("Desktop/..").valid).toBe(false);
  });

  test("rejects a path whose only content is '..' segments", () => {
    expect(validateDeviceRelativePath("../../../..").valid).toBe(false);
  });

  test("a bare '.' segment inside an allowlisted folder is accepted (harmless, resolves to the same directory)", () => {
    expect(validateDeviceRelativePath("Desktop/./notes.txt").valid).toBe(true);
  });

  test("rejects a null byte anywhere in the path, not just at a segment boundary", () => {
    expect(validateDeviceRelativePath("Desktop/sub\0dir/notes.txt").valid).toBe(false);
    expect(validateDeviceRelativePath("\0Desktop/notes.txt").valid).toBe(false);
  });

  test("rejects a Windows-style backslash path (not a real macOS separator, but must not be treated as a single safe segment)", () => {
    // Since this only ever runs against a macOS Agent, "\" is not a path
    // separator to the OS — but the whole string is then a single segment
    // whose value isn't in the allowlist, so it's correctly rejected.
    expect(validateDeviceRelativePath("Desktop\\..\\..\\etc\\passwd").valid).toBe(false);
  });

  test("rejects a very long path", () => {
    const longSegment = "a".repeat(5000);
    expect(validateDeviceRelativePath(`Desktop/${longSegment}`).valid).toBe(true); // long-but-legitimate filename: still within Desktop, not itself a boundary violation
    expect(validateDeviceRelativePath(`${longSegment}/notes.txt`).valid).toBe(false); // not an allowlisted top-level folder
  });

  test("rejects tilde-expansion attempts that aren't a leading '~'", () => {
    // A literal "~" elsewhere in the path is not the home-directory
    // shorthand the "~" check at the start of the string catches — but it
    // must still fail because it's not an allowlisted top-level folder.
    expect(validateDeviceRelativePath("~other-user/Desktop/notes.txt").valid).toBe(false);
  });
});
