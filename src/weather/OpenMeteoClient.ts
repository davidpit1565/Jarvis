export interface CurrentWeather {
  temperatureC: number;
  windSpeedKph: number;
  description: string;
  isDay: boolean;
}

const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

// WMO weather codes, as returned by Open-Meteo's `current_weather.weathercode`.
// https://open-meteo.com/en/docs — only the codes Open-Meteo actually returns.
const WEATHER_CODE_DESCRIPTIONS: Record<number, string> = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "moderate drizzle",
  55: "dense drizzle",
  56: "light freezing drizzle",
  57: "dense freezing drizzle",
  61: "slight rain",
  63: "moderate rain",
  65: "heavy rain",
  66: "light freezing rain",
  67: "heavy freezing rain",
  71: "slight snow fall",
  73: "moderate snow fall",
  75: "heavy snow fall",
  77: "snow grains",
  80: "slight rain showers",
  81: "moderate rain showers",
  82: "violent rain showers",
  85: "slight snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with slight hail",
  99: "thunderstorm with heavy hail",
};

function describeWeatherCode(code: number): string {
  return WEATHER_CODE_DESCRIPTIONS[code] ?? `unknown conditions (code ${code})`;
}

/**
 * Current weather via Open-Meteo's free forecast API — no API key, no
 * account, no cost, matching this project's "as close to free as possible"
 * goal. One fixed location (JARVIS_WEATHER_LATITUDE/LONGITUDE), since a
 * personal assistant only ever needs to know the weather where its one
 * user actually is, not a general-purpose geocoding lookup.
 */
export class OpenMeteoClient {
  constructor(
    private readonly latitude: number,
    private readonly longitude: number
  ) {}

  async getCurrentWeather(): Promise<CurrentWeather> {
    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set("latitude", String(this.latitude));
    url.searchParams.set("longitude", String(this.longitude));
    url.searchParams.set("current_weather", "true");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw new Error(`Open-Meteo request failed (${response.status}): ${await response.text().catch(() => "")}`);
    }

    const data = (await response.json()) as {
      current_weather?: { temperature: number; windspeed: number; weathercode: number; is_day: number };
    };

    if (!data.current_weather) {
      throw new Error("Open-Meteo response didn't include current_weather");
    }

    const { temperature, windspeed, weathercode, is_day } = data.current_weather;
    return {
      temperatureC: temperature,
      windSpeedKph: windspeed,
      description: describeWeatherCode(weathercode),
      isDay: is_day === 1,
    };
  }
}
