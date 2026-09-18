import { describe, test, expect, afterEach } from "bun:test";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";
import { createGetWeatherForecastTool } from "@/tools/weather/GetWeatherForecastTool";
import { PermissionLevel } from "@/types/permissions";

const context = { userId: "user-1", requestId: "req-1" };
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("GET_WEATHER_FORECAST tool", () => {
  test("is READ", () => {
    const tool = createGetWeatherForecastTool(new OpenMeteoClient(0, 0));
    expect(tool.requiredPermission).toBe(PermissionLevel.READ);
  });

  test("returns the forecast on success", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          daily: {
            time: ["2026-01-15"],
            temperature_2m_min: [10],
            temperature_2m_max: [18],
            weathercode: [0],
            precipitation_probability_max: [0],
          },
        }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const tool = createGetWeatherForecastTool(new OpenMeteoClient(32.08, 34.78));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(true);
    expect((result.data as { forecast: unknown[] }).forecast).toHaveLength(1);
  });

  test("rejects an invalid days value", async () => {
    const tool = createGetWeatherForecastTool(new OpenMeteoClient(0, 0));
    const result = await tool.execute({ days: -1 }, context);
    expect(result.success).toBe(false);
  });

  test("caps days at 7", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({
          daily: { time: [], temperature_2m_min: [], temperature_2m_max: [], weathercode: [], precipitation_probability_max: [] },
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const tool = createGetWeatherForecastTool(new OpenMeteoClient(0, 0));
    await tool.execute({ days: 30 }, context);

    expect(capturedUrl).toContain("forecast_days=7");
  });

  test("returns a failure result (not a throw) when the request fails", async () => {
    global.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;

    const tool = createGetWeatherForecastTool(new OpenMeteoClient(0, 0));
    const result = await tool.execute({}, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("500");
  });
});
