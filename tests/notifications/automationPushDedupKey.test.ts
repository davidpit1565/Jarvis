import { describe, test, expect } from "bun:test";
import { NotificationDedup } from "@/notifications/NotificationDedup";

/**
 * Mirrors index.ts's automationRuleInterval tick — specifically the fix
 * scoping the NotificationDedup key for an automation rule's result push
 * to `automation-push:${ruleId}:${reply}` instead of just
 * `automation-push:${reply}`. Two independent rules can easily produce the
 * same reply text (e.g. both say "Nothing new."), and a content-only key
 * let one rule's push silently suppress a different rule's push within
 * NotificationDedup's window — the user never learned the second rule ran
 * at all, with no error anywhere.
 */
describe("automation-rule push dedup key", () => {
  test("a content-only dedup key lets one rule's push suppress a different rule's identical-text push (the bug)", () => {
    const dedup = new NotificationDedup(60_000);
    const buggyKey = (reply: string) => `automation-push:${reply}`;

    expect(dedup.shouldSend(buggyKey("Nothing new."), 1_000)).toBe(true); // rule A's push goes out
    expect(dedup.shouldSend(buggyKey("Nothing new."), 30_000)).toBe(false); // rule B's push wrongly suppressed
  });

  test("scoping the key by ruleId lets two different rules push the same text independently (the fix)", () => {
    const dedup = new NotificationDedup(60_000);
    const key = (ruleId: string, reply: string) => `automation-push:${ruleId}:${reply}`;

    expect(dedup.shouldSend(key("rule-a", "Nothing new."), 1_000)).toBe(true);
    expect(dedup.shouldSend(key("rule-b", "Nothing new."), 30_000)).toBe(true);
  });

  test("the same rule's own duplicate within the window is still suppressed", () => {
    const dedup = new NotificationDedup(60_000);
    const key = (ruleId: string, reply: string) => `automation-push:${ruleId}:${reply}`;

    expect(dedup.shouldSend(key("rule-a", "Nothing new."), 1_000)).toBe(true);
    expect(dedup.shouldSend(key("rule-a", "Nothing new."), 30_000)).toBe(false);
  });
});
