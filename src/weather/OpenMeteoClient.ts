import { apiError } from "@/core/net/apiError";

export interface CurrentWeather {
  temperatureC: number;
  windSpeedKph: number;
  description: string;
  isDay: boolean;
}

export interface DailyForecastDay {
  date: string;
  minTemperatureC: number;
  maxTemperatureC: number;
  description: string;
  precipitationChancePercent: number;
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

// Weather doesn't meaningfully change minute to minute, so a short cache
// avoids hitting Open-Meteo again for every "what's the weather" asked in
// quick succession within the same conversation — real latency/load
// savings at zero cost, since there's no per-request charge to avoid.
const CURRENT_WEATHER_CACHE_TTL_MS = 5 * 60_000;

/**
 * Current weather via Open-Meteo's free forecast API — no API key, no
 * account, no cost, matching this project's "as close to free as possible"
 * goal. One fixed location (JARVIS_WEATHER_LATITUDE/LONGITUDE), since a
 * personal assistant only ever needs to know the weather where its one
 * user actually is, not a general-purpose geocoding lookup.
 */
export class OpenMeteoClient {
  private cachedCurrentWeather: { value: CurrentWeather; fetchedAt: number } | undefined;

  constructor(
    private readonly latitude: number,
    private readonly longitude: number
  ) {}

  async getCurrentWeather(): Promise<CurrentWeather> {
    if (this.cachedCurrentWeather && Date.now() - this.cachedCurrentWeather.fetchedAt < CURRENT_WEATHER_CACHE_TTL_MS) {
      return this.cachedCurrentWeather.value;
    }

    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set("latitude", String(this.latitude));
    url.searchParams.set("longitude", String(this.longitude));
    url.searchParams.set("current_weather", "true");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw await apiError("Open-Meteo request failed", response);
    }

    const data = (await response.json()) as {
      current_weather?: { temperature: number; windspeed: number; weathercode: number; is_day: number };
    };

    if (!data.current_weather) {
      throw new Error("Open-Meteo response didn't include current_weather");
    }

    const { temperature, windspeed, weathercode, is_day } = data.current_weather;
    const weather: CurrentWeather = {
      temperatureC: temperature,
      windSpeedKph: windspeed,
      description: describeWeatherCode(weathercode),
      isDay: is_day === 1,
    };
    this.cachedCurrentWeather = { value: weather, fetchedAt: Date.now() };
    return weather;
  }

  /** Daily min/max temperature, conditions, and precipitation chance for the next `days` days (including today). */
  async getDailyForecast(days: number = 3): Promise<DailyForecastDay[]> {
    const url = new URL(OPEN_METEO_FORECAST_URL);
    url.searchParams.set("latitude", String(this.latitude));
    url.searchParams.set("longitude", String(this.longitude));
    url.searchParams.set("daily", "temperature_2m_min,temperature_2m_max,weathercode,precipitation_probability_max");
    url.searchParams.set("forecast_days", String(days));
    url.searchParams.set("timezone", "auto");

    const response = await fetch(url.toString());
    if (!response.ok) {
      throw await apiError("Open-Meteo request failed", response);
    }

    const data = (await response.json()) as {
      daily?: {
        time: string[];
        temperature_2m_min: number[];
        temperature_2m_max: number[];
        weathercode: number[];
        precipitation_probability_max: number[];
      };
    };

    if (!data.daily) {
      throw new Error("Open-Meteo response didn't include daily forecast");
    }

    return data.daily.time.map((date, i) => ({
      date,
      minTemperatureC: data.daily!.temperature_2m_min[i]!,
      maxTemperatureC: data.daily!.temperature_2m_max[i]!,
      description: describeWeatherCode(data.daily!.weathercode[i]!),
      precipitationChancePercent: data.daily!.precipitation_probability_max[i]!,
    }));
  }
}
