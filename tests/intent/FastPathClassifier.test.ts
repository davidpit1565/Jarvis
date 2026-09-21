import { describe, test, expect } from "bun:test";
import { classifyFastPath } from "@/core/intent/FastPathClassifier";

describe("classifyFastPath", () => {
  describe("weather", () => {
    test.each([
      "what's the weather?",
      "what's the weather like",
      "whats the weather today",
      "weather",
      "weather outside",
      "how's the weather",
      "is it going to rain?",
      "will it rain today?",
      "do i need a jacket",
      "do i need an umbrella",
    ])("matches %s", (message) => {
      const match = classifyFastPath(message);
      expect(match).not.toBeNull();
      expect(match?.toolName).toBe("get_weather");
      expect(match?.input).toEqual({});
    });

    test("does not match a location-specific question — the tool can't safely honor a city argument", () => {
      expect(classifyFastPath("weather in Tel Aviv?")).toBeNull();
      expect(classifyFastPath("what's the weather in Paris")).toBeNull();
    });

    test("does not match a forecast question — that's a different tool", () => {
      expect(classifyFastPath("what's the weather forecast for tomorrow")).toBeNull();
      expect(classifyFastPath("weather this week")).toBeNull();
    });
  });

  describe("calendar", () => {
    test.each(["what's on my calendar?", "what's on my calendar today", "am i free today", "what's my schedule today"])(
      "matches %s",
      (message) => {
        const match = classifyFastPath(message);
        expect(match).not.toBeNull();
        expect(match?.toolName).toBe("list_calendar_events");
        expect(match?.input).toEqual({});
      }
    );

    test("does not match a request with a filter/date the tool can't express", () => {
      expect(classifyFastPath("what's on my calendar next week")).toBeNull();
      expect(classifyFastPath("am I free at 3pm on Tuesday")).toBeNull();
    });
  });

  describe("spotify", () => {
    test("pause", () => {
      expect(classifyFastPath("pause the music")?.toolName).toBe("pause_music");
      expect(classifyFastPath("pause")?.toolName).toBe("pause_music");
      expect(classifyFastPath("stop the music")?.toolName).toBe("pause_music");
    });

    test("play/resume with no query", () => {
      const match = classifyFastPath("play the music");
      expect(match?.toolName).toBe("play_music");
      expect(match?.input).toEqual({});
    });

    test("does not match a request naming a specific song — the classifier can't safely fill in `query`", () => {
      expect(classifyFastPath("play Bohemian Rhapsody")).toBeNull();
      expect(classifyFastPath("play some jazz")).toBeNull();
    });

    test("skip (next)", () => {
      expect(classifyFastPath("skip")?.toolName).toBe("skip_track");
      expect(classifyFastPath("skip this song")).toEqual({ toolName: "skip_track", input: {}, shape: "spotify.skip.next" });
      expect(classifyFastPath("next track")).toEqual({ toolName: "skip_track", input: {}, shape: "spotify.skip.next" });
    });

    test("skip (previous)", () => {
      expect(classifyFastPath("previous song")).toEqual({
        toolName: "skip_track",
        input: { direction: "previous" },
        shape: "spotify.skip.previous",
      });
      expect(classifyFastPath("go back a track")?.input).toEqual({ direction: "previous" });
    });

    test("currently playing", () => {
      expect(classifyFastPath("what's playing")?.toolName).toBe("get_currently_playing");
      expect(classifyFastPath("what's currently playing")?.toolName).toBe("get_currently_playing");
    });
  });

  describe("conservative fall-through (bias toward NOT fast-pathing anything ambiguous)", () => {
    test.each([
      "hi",
      "thanks",
      "what's the weather and what's on my calendar",
      "can you check the weather and pause the music",
      "tell me a joke about the weather",
      "",
      "   ",
      "what's the weather like for my meeting tomorrow",
    ])("returns null for %s", (message) => {
      expect(classifyFastPath(message)).toBeNull();
    });
  });
});
