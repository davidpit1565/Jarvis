import { describe, test, expect, afterEach } from "bun:test";
import { OpenMeteoClient } from "@/weather/OpenMeteoClient";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("OpenMeteoClient.getCurrentWeather", () => {
  test("maps a successful response into CurrentWeather", async () => {
    let capturedUrl: string | undefined;
    global.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(
        JSON.stringify({ current_weather: { temperature: 21.4, windspeed: 12.3, weathercode: 1, is_day: 1 } }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const client = new OpenMeteoClient(32.08, 34.78);
    const weather = await client.getCurrentWeather();

    expect(weather).toEqual({ temperatureC: 21.4, windSpeedKph: 12.3, description: "mainly clear", isDay: true });
    expect(capturedUrl).toContain("latitude=32.08");
    expect(capturedUrl).toContain("longitude=34.78");
    expect(capturedUrl).toContain("current_weather=true");
  });

  test("falls back to a generic description for an unmapped weather code", async () => {
    global.fetch = (async () =>
      new Response(
        JSON.stringify({ current_weather: { temperature: 5, windspeed: 1, weathercode: 9999, is_day: 0 } }),
        { status: 200 }
      )) as unknown as typeof fetch;

    const client = new OpenMeteoClient(0, 0);
    const weather = await client.getCurrentWeather();

    expect(weather.description).toContain("9999");
    expect(weather.isDay).toBe(false);
  });

  test("throws on a non-2xx response", async () => {
    global.fetch = (async () => new Response("bad request", { status: 400 })) as unknown as typeof fetch;

    const client = new OpenMeteoClient(0, 0);
    await expect(client.getCurrentWeather()).rejects.toThrow(/400/);
  });

  test("throws if the response is missing current_weather", async () => {
    global.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

    const client = new OpenMeteoClient(0, 0);
    await expect(client.getCurrentWeather()).rejects.toThrow(/current_weather/);
  });
});
