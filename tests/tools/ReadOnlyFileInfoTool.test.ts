import { describe, test, expect } from "bun:test";
import { readOnlyFileInfoTool } from "@/tools/filesystem/ReadOnlyFileInfoTool";
import { validateFilePath } from "@/tools/filesystem/pathValidation";

const context = { userId: "user-1", requestId: "req-1" };

describe("pathValidation", () => {
  test("accepts a path within the allowed root", () => {
    const result = validateFilePath("package.json");
    expect(result.valid).toBe(true);
  });

  test("rejects paths escaping the allowed root via traversal", () => {
    const result = validateFilePath("../../etc/passwd");
    expect(result.valid).toBe(false);
  });

  test("rejects sensitive absolute paths", () => {
    const result = validateFilePath("/etc/passwd", "/etc");
    expect(result.valid).toBe(false);
  });

  test("rejects paths with null bytes", () => {
    const result = validateFilePath("package.json\0.txt");
    expect(result.valid).toBe(false);
  });

  test("rejects empty paths", () => {
    const result = validateFilePath("");
    expect(result.valid).toBe(false);
  });

  test("rejects paths matching sensitive filename patterns", () => {
    const result = validateFilePath(".ssh/id_rsa");
    expect(result.valid).toBe(false);
  });
});

describe("readOnlyFileInfoTool", () => {
  test("reports an existing file", async () => {
    const result = await readOnlyFileInfoTool.execute({ path: "package.json" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { exists: boolean }).exists).toBe(true);
  });

  test("reports a non-existent file without error", async () => {
    const result = await readOnlyFileInfoTool.execute({ path: "definitely-not-here.txt" }, context);
    expect(result.success).toBe(true);
    expect((result.data as { exists: boolean }).exists).toBe(false);
  });

  test("rejects dangerous paths instead of touching the filesystem", async () => {
    const result = await readOnlyFileInfoTool.execute({ path: "../../etc/passwd" }, context);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("is registered with READ permission", () => {
    expect(readOnlyFileInfoTool.requiredPermission).toBe("READ");
  });
});
