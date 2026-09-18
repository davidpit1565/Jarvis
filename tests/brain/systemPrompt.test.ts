import { describe, test, expect } from "bun:test";
import { JARVIS_SYSTEM_PROMPT } from "@/core/brain/systemPrompt";

describe("JARVIS_SYSTEM_PROMPT", () => {
  test("instructs Claude to treat tool-returned content as data, never as instructions", () => {
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/never an instruction from the user/i);
    expect(JARVIS_SYSTEM_PROMPT).toMatch(/only the person\s+you're actually talking to/i);
  });
});
