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
});
