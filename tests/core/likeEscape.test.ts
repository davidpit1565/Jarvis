import { describe, test, expect } from "bun:test";
import { escapeLikeFragment } from "@/core/db/likeEscape";

describe("escapeLikeFragment", () => {
  test("escapes a literal underscore so it isn't treated as a single-character wildcard", () => {
    expect(escapeLikeFragment("wifi_password")).toBe("wifi\\_password");
  });

  test("escapes a literal percent sign so it isn't treated as a multi-character wildcard", () => {
    expect(escapeLikeFragment("50% off")).toBe("50\\% off");
  });

  test("escapes a literal backslash first, so it isn't misread as introducing an escape sequence", () => {
    expect(escapeLikeFragment("C:\\temp")).toBe("C:\\\\temp");
  });

  test("leaves ordinary text unchanged", () => {
    expect(escapeLikeFragment("timezone")).toBe("timezone");
  });
});
