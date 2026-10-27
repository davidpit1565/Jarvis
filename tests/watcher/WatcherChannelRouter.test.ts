import { describe, test, expect } from "bun:test";
import { routeWatcherSource, emptyWatcherChannelConfig } from "@/watcher/WatcherChannelRouter";

describe("routeWatcherSource", () => {
  test("defaults every source to the telegram channel with no configuration", () => {
    const decision = routeWatcherSource("news:ai safety", emptyWatcherChannelConfig());
    expect(decision.channel).toBe("telegram");
  });

  test("routes a source explicitly configured as high-priority to device-announce", () => {
    const config = { ...emptyWatcherChannelConfig(), highPrioritySourceIds: new Set(["news:urgent"]) };
    expect(routeWatcherSource("news:urgent", config).channel).toBe("device-announce");
    // An unrelated source stays on the default channel — this is never a global switch.
    expect(routeWatcherSource("news:other", config).channel).toBe("telegram");
  });

  test("routes a source explicitly configured for phone to the phone channel, in principle", () => {
    const config = { ...emptyWatcherChannelConfig(), phoneSourceIds: new Set(["github:owner/repo"]) };
    expect(routeWatcherSource("github:owner/repo", config).channel).toBe("phone");
  });

  test("phone takes precedence over high-priority if a source is (unusually) configured for both", () => {
    const config = {
      ...emptyWatcherChannelConfig(),
      highPrioritySourceIds: new Set(["s1"]),
      phoneSourceIds: new Set(["s1"]),
    };
    expect(routeWatcherSource("s1", config).channel).toBe("phone");
  });

  test("a source pinned to alwaysQuietSourceIds never escalates, even if also configured high-priority or phone", () => {
    const config = {
      ...emptyWatcherChannelConfig(),
      highPrioritySourceIds: new Set(["self-improvement"]),
      phoneSourceIds: new Set(["self-improvement"]),
      alwaysQuietSourceIds: new Set(["self-improvement"]),
    };
    expect(routeWatcherSource("self-improvement", config).channel).toBe("telegram");
  });

  test("never escalates a source nobody configured, regardless of source id shape", () => {
    const config = emptyWatcherChannelConfig();
    expect(routeWatcherSource("anything-at-all", config).channel).toBe("telegram");
  });
});
