import { describe, test, expect, afterEach } from "bun:test";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";
import { createGetWeatherTool } from "@/tools/weather/GetWeatherTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET_WEATHER tool", () => {
  test("is READ", () => {
    const tool = createGetWeatherTool(new OpenMeteoClient(0, 0));
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the current weather on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ current_weather: { temperature: 18, windspeed: 5, weathercode: 0, is_day: 1 } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createGetWeatherTool(new OpenMeteoClient(32.08, 34.78));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ temperatureC: 18, windSpeedKph: 5, description: "clear sky", isDay: true });
  });

  test("returns a failure result (not a throw) when the request fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createGetWeatherTool(new OpenMeteoClient(0, 0));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
