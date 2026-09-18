import { PermissionLevel } from "@/types/permissions";
import type { LocalTool } from "@/types/tools";
import type { OpenMeteoClient } from "@/weather/OpenMeteoClient";

/**
 * Lets Claude answer "what's the weather" / "will it rain today" / "should
 * I bring a jacket" with a real current-weather lookup for the user's one
 * configured location. READ-only, and free (Open-Meteo, no API key).
 */
export function createGetWeatherTool(weatherClient: OpenMeteoClient): LocalTool {
  return {
    id: "GET_WEATHER",
    name: "get_weather",
    description:
      "Gets the current weather (temperature, wind, conditions) at the user's configured location. Use this to " +
      'answer questions about weather ("what\'s the weather like", "will it rain", "is it cold out").',
    inputSchema: { type: "object", properties: {} },
    requiredPermission: PermissionLevel.READ,
    target: "local",

    async execute() {
      try {
        const weather = await weatherClient.getCurrentWeather();
        return { success: true, data: weather };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}
