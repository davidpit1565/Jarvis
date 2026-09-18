import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { OpenMeteoClient } from "@/weather/OpenMeteoClient";

export interface GetWeatherForecastInput extends Record<string, unknown> {
  days?: number;
}

/**
 * GET_WEATHER only covers right now — this answers "will it rain
 * tomorrow" / "what's the weather like this week" with a real multi-day
 * outlook (min/max temp, conditions, precipitation chance) for the user's
 * one configured location. READ-only, same free Open-Meteo API.
 */
export function createGetWeatherForecastTool(weatherClient: OpenMeteoClient): LocalTool<GetWeatherForecastInput> {
  return {
    id: "GET_WEATHER_FORECAST",
    name: "get_weather_forecast",
    description:
      "Gets the daily weather forecast (min/max temperature, conditions, chance of rain) for the next several " +
      'days at the user\'s configured location. Use this for "will it rain tomorrow" or "what\'s the weather ' +
      'like this week" — for right now, use get_weather instead.',
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Number of days to forecast, including today. Defaults to 3, capped at 7." },
      },
    },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute(input) {
      const days = typeof input.days === "number" ? input.days : undefined;
      if (days !== undefined && (!Number.isInteger(days) || days <= 0)) {
        return { success: false, error: "days must be a positive integer" };
      }

      try {
        const forecast = await weatherClient.getDailyForecast(days !== undefined ? Math.min(days, 7) : undefined);
        return { success: true, data: { forecast } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
