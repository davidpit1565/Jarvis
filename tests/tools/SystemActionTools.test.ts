import { describe, test, expect } from "bun:test";
import { validateUrl } from "@/tools/system/urlValidation";
import { validateAppName } from "@/tools/system/appNameValidation";
import { validateEmailAddress } from "@/tools/system/emailValidation";
import { openUrlTool } from "@/tools/system/OpenUrlTool";
import { openApplicationTool } from "@/tools/system/OpenApplicationTool";
import { composeEmailDraftTool } from "@/tools/system/ComposeEmailDraftTool";
import { clickElementTool } from "@/tools/system/ClickElementTool";
import { typeTextTool } from "@/tools/system/TypeTextTool";
import { PermissionLevel } from "@/types/permissions";

describe("validateUrl", () => {
  test("accepts http and https URLs", () => {
    expect(validateUrl("https://example.com").valid).toBe(true);
    expect(validateUrl("http://example.com/path?q=1").valid).toBe(true);
  });

  test("rejects every other scheme", () => {
    expect(validateUrl("javascript:alert(1)").valid).toBe(false);
    expect(validateUrl("file:///etc/passwd").valid).toBe(false);
    expect(validateUrl("data:text/html,<script>1</script>").valid).toBe(false);
  });

  test("rejects malformed or empty input", () => {
    expect(validateUrl("").valid).toBe(false);
    expect(validateUrl("not a url").valid).toBe(false);
    // @ts-expect-error deliberately wrong type, matching a misbehaving caller
    expect(validateUrl(null).valid).toBe(false);
  });
});

describe("validateAppName", () => {
  test("accepts real macOS app names", () => {
    expect(validateAppName("Safari").valid).toBe(true);
    expect(validateAppName("1Password 7").valid).toBe(true);
    expect(validateAppName("Bear - Notes").valid).toBe(true);
  });

  test("rejects shell/path metacharacters", () => {
    expect(validateAppName("Safari; rm -rf /").valid).toBe(false);
    expect(validateAppName("../../etc/passwd").valid).toBe(false);
    expect(validateAppName("$(whoami)").valid).toBe(false);
  });

  test("rejects empty input", () => {
    expect(validateAppName("").valid).toBe(false);
    expect(validateAppName("   ").valid).toBe(false);
  });
});

describe("validateEmailAddress", () => {
  test("accepts a well-formed address", () => {
    expect(validateEmailAddress("jarvis@example.com").valid).toBe(true);
  });

  test("rejects malformed addresses and header-injection attempts", () => {
    expect(validateEmailAddress("not-an-email").valid).toBe(false);
    expect(validateEmailAddress("a@b.com\nBcc: everyone@example.com").valid).toBe(false);
    expect(validateEmailAddress("").valid).toBe(false);
  });
});

describe("system action tool definitions", () => {
  for (const tool of [openUrlTool, openApplicationTool, composeEmailDraftTool]) {
    test(`${tool.id} is a SAFE_ACTION device tool with its own input validation`, () => {
      expect(tool.target).toBe("device");
      expect(tool.requiredPermission).toBe(PermissionLevel.SAFE_ACTION);
      expect(typeof tool.validateInput).toBe("function");
    });
  }

  test("OPEN_URL rejects a non-http(s) scheme via its own validateInput", () => {
    expect(openUrlTool.validateInput!({ url: "javascript:evil()" }).valid).toBe(false);
    expect(openUrlTool.validateInput!({ url: "https://example.com" }).valid).toBe(true);
  });

  test("OPEN_APPLICATION rejects an unsafe application name via its own validateInput", () => {
    expect(openApplicationTool.validateInput!({ applicationName: "Safari; rm -rf /" }).valid).toBe(false);
    expect(openApplicationTool.validateInput!({ applicationName: "Safari" }).valid).toBe(true);
  });

  test("COMPOSE_EMAIL_DRAFT rejects a malformed recipient via its own validateInput", () => {
    expect(composeEmailDraftTool.validateInput!({ to: "not-an-email" }).valid).toBe(false);
    expect(composeEmailDraftTool.validateInput!({ to: "someone@example.com" }).valid).toBe(true);
  });
});

describe("broader computer-control tools are gated at CONFIRM, not SAFE_ACTION", () => {
  // Direct user decision: broader "do things on the computer for me" is
  // wanted, but strictly on-demand and never on the model's own
  // initiative. The architecture already guarantees "only when asked"
  // (every tool call originates from a real user message — no autonomous
  // loop exists anywhere in this codebase); these tools' own job is
  // real-time human confirmation of *what* gets clicked/typed, since
  // unlike the three narrow SAFE_ACTION tools above, either could act on
  // anything the frontmost app currently shows.
  for (const tool of [clickElementTool, typeTextTool]) {
    test(`${tool.id} is a CONFIRM-level device tool`, () => {
      expect(tool.target).toBe("device");
      expect(tool.requiredPermission).toBe(PermissionLevel.CONFIRM);
    });
  }

  test("CLICK_ELEMENT takes only a semantic description, never raw coordinates", () => {
    const props = clickElementTool.inputSchema.properties as Record<string, unknown>;
    expect(props.description).toBeDefined();
    expect(props.x).toBeUndefined();
    expect(props.y).toBeUndefined();
    expect(props.coordinates).toBeUndefined();
  });

  test("CLICK_ELEMENT rejects an empty description via its own validateInput", () => {
    expect(clickElementTool.validateInput!({ description: "" }).valid).toBe(false);
    expect(clickElementTool.validateInput!({ description: "   " }).valid).toBe(false);
    expect(clickElementTool.validateInput!({ description: "Send" }).valid).toBe(true);
  });

  test("TYPE_TEXT rejects empty text via its own validateInput", () => {
    expect(typeTextTool.validateInput!({ text: "" }).valid).toBe(false);
    expect(typeTextTool.validateInput!({ text: "hello" }).valid).toBe(true);
  });
});
