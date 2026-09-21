import { describe, test, expect } from "bun:test";
import { classifyError } from "@/agent/errorClassification";

describe("classifyError", () => {
  test("classifies timeouts, network errors and rate limits as transient", () => {
    expect(classifyError("Request timed out")).toBe("transient");
    expect(classifyError("connect ECONNREFUSED 127.0.0.1:443")).toBe("transient");
    expect(classifyError("Rate limited, try again later")).toBe("transient");
    expect(classifyError("upstream 503 Service Unavailable")).toBe("transient");
    expect(classifyError("The device disconnected mid-request")).toBe("transient");
  });

  test("classifies permission/authorization/validation failures as permanent", () => {
    expect(classifyError("Permission denied: no grant")).toBe("permanent");
    expect(classifyError("Unknown tool: does_not_exist")).toBe("permanent");
    expect(classifyError("Invalid input: bad scheme")).toBe("permanent");
    expect(classifyError("User declined to confirm this action")).toBe("permanent");
  });

  test("defaults unknown or missing errors to permanent", () => {
    expect(classifyError(undefined)).toBe("permanent");
    expect(classifyError(null)).toBe("permanent");
    expect(classifyError("something unexpected happened")).toBe("permanent");
  });
});
