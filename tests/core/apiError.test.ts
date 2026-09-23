import { describe, test, expect, spyOn } from "bun:test";
import { apiError } from "@/core/net/apiError";

describe("apiError", () => {
  test("the thrown error's message carries only the context and status, never the raw response body", async () => {
    const response = new Response(
      JSON.stringify({ error: { code: 403, message: "Request had insufficient authentication scopes.", reason: "insufficientPermissions" } }),
      { status: 403 }
    );

    const error = await apiError("Gmail send failed", response);

    expect(error.message).toBe("Gmail send failed (403)");
    expect(error.message).not.toContain("insufficientPermissions");
    expect(error.message).not.toContain("insufficient authentication scopes");
  });

  test("logs the raw body server-side for debugging, without it ever reaching the thrown message", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    const response = new Response("raw provider detail", { status: 500 });

    const error = await apiError("Spotify play failed", response);

    expect(error.message).toBe("Spotify play failed (500)");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Spotify play failed"), "raw provider detail");
    errorSpy.mockRestore();
  });

  test("handles an empty response body without throwing during construction", async () => {
    const response = new Response(null, { status: 401 });
    const error = await apiError("Google OAuth token refresh failed", response);
    expect(error.message).toBe("Google OAuth token refresh failed (401)");
  });
});
