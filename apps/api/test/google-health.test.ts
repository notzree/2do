import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vite-plus/test";
import type { ConnectorEnv, GoogleConnection } from "../src/connectors/connection.ts";
import { scopes, seal } from "../src/connectors/auth.ts";
import { connectors } from "../src/connectors/router.ts";
import { reportingDay, nextReportDay } from "../src/interfaces/plugin-reports.ts";

it("imports wearable workouts through the Google connection and reconciles Fitness goals and reports", async () => {
  const bindings = env as unknown as ConnectorEnv;
  const planner = bindings.USER_PLANNER.getByName("dev:local");
  const connection = bindings.GOOGLE_CONNECTION.getByName("google-health/" + planner.id);
  const testEnv = { ...env, ...bindings, LOCAL_PLANNER: "enabled" as const };
  const base = "http://localhost/api/connections/google-health";
  async function request(path: string, method = "GET", body?: object) {
    const result = await planner.fetch("https://planner.test/api/" + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await result.text();
    expect(result.ok, path + ": " + text).toBe(true);
    return text ? JSON.parse(text) : null;
  }
  const response = await connectors.request(
    base + "/authorize",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    testEnv,
  );
  expect(response.status).toBe(200);
  const consent = new URL(((await response.json()) as { url: string }).url);
  expect(consent.searchParams.get("scope")?.split(" ")).toEqual([
    "openid",
    "email",
    "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  ]);
  expect(consent.searchParams.get("redirect_uri")).toBe(
    "https://twodo.example/api/connections/google-health/callback",
  );

  const installed = Date.now();
  const start = new Date(installed - 65 * 60_000);
  const date = reportingDay("UTC", start);
  const rows = (km: number, elapsed: number) => [
    {
      dataPointName: "users/test/dataTypes/exercise/dataPoints/1234",
      exercise: {
        exerciseType: "RUNNING",
        activeDuration: "1680s",
        interval: {
          startTime: start.toISOString(),
          endTime: new Date(+start + elapsed * 60_000).toISOString(),
        },
        metricsSummary: { distanceMillimeters: km * 1_000_000 },
      },
    },
  ];
  let exercises = rows(4.2, 32);
  let incomplete = false;
  let failNext = false;
  const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "oauth2.googleapis.com")
      return Response.json({ access_token: "test-access", expires_in: 3600, token_type: "Bearer" });
    expect(url.host + url.pathname).toBe(
      "health.googleapis.com/v4/users/me/dataTypes/exercise/dataPoints:reconcile",
    );
    expect(url.searchParams.get("dataSourceFamily")).toBe(
      "users/me/dataSourceFamilies/google-wearables",
    );
    const filter = url.searchParams.get("filter")!;
    const [, from, to] =
      /exercise\.interval\.civil_start_time >= "([^"]+)" AND exercise\.interval\.civil_start_time < "([^"]+)"/.exec(
        filter,
      )!;
    if (failNext) {
      failNext = false;
      return Response.json({ error: { message: "temporary" } }, { status: 503 });
    }
    if (incomplete) {
      incomplete = false;
      return Response.json({ dataPoints: [], nextPageToken: "page-two" });
    }
    return Response.json({ dataPoints: from <= date && date < to ? exercises : [] });
  });
  const tick = () =>
    runInDurableObject(connection, async (obj, ctx) => {
      await (obj as GoogleConnection).alarm();
      // Drive subsequent pages explicitly instead of racing the runtime's 1ms alarm.
      await ctx.storage.deleteAlarm();
      return !!ctx.storage.kv.get("workout-scan");
    });
  async function sync() {
    for (let i = 0; i < 6; i++) {
      const scanning = await tick();
      expect((await connection.status("google-health")).error).toBeNull();
      if (!scanning) return;
    }
    throw new Error("Scan failed to finish");
  }
  const series = async (metric: string) =>
    (
      await request(
        "plugin-metrics/fitness." +
          metric +
          "/series?bucket=day&weekStart=1&from=" +
          date +
          "&to=" +
          nextReportDay(date),
      )
    ).buckets[0];
  try {
    const token = await seal(
      "test-refresh",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      connection.id.toString(),
    );
    await runInDurableObject(connection, (_, ctx) =>
      ctx.storage.kv.put("grant", {
        kind: "google-health",
        planner: planner.id.toString(),
        account: "fixture",
        email: "fixture@example.com",
        sub: "fixture",
        token,
        permissions: scopes("google-health", { importEvents: false, exportEvents: false }),
        options: { importEvents: false, exportEvents: false },
        installed,
      }),
    );
    await tick();
    expect((await connection.status("google-health")).error).toContain("Enable Fitness");
    expect(transport).not.toHaveBeenCalled();
    await request("task-plugins/fitness", "PUT", { enabled: true });
    const goal = await request("planner-goals", "POST", {
      id: crypto.randomUUID(),
      title: "5 km in 30 minutes",
      subtype: { typeId: "fitness.run-performance", version: 1, data: { km: 5, minutes: 30 } },
    });
    const weekly = await request("planner-goals", "POST", {
      id: crypto.randomUUID(),
      title: "Three activities",
      subtype: {
        typeId: "fitness.weekly-activity",
        version: 1,
        data: { count: 3 },
      },
    });
    const achieved = async () =>
      (await request("planner-goals")).find((g: { id: string }) => g.id === goal.id).achieved;
    await sync();
    await sync();
    expect(await series("sessions")).toMatchObject({ value: 1, known: 1 });
    expect(await series("minutes")).toMatchObject({ value: 28 });
    const progress = await request("planner-goals/" + weekly.id + "/progress?day=" + date);
    expect(progress.label).toContain("1 of 3 sessions");
    expect(await series("distance")).toMatchObject({ value: 4.2 });
    expect(await achieved()).toBe(false);
    const recent = await connectors.request(base + "/workouts", {}, testEnv);
    expect(await recent.json()).toEqual([
      { activity: "running", start: start.toISOString(), minutes: 28, km: 4.2 },
    ]);
    exercises = rows(5, 32);
    await sync();
    expect(await series("run-minutes")).toMatchObject({ value: 32 });
    expect(await achieved()).toBe(false);
    exercises = rows(5, 29);
    await sync();
    expect(await achieved()).toBe(true);
    exercises = [];
    incomplete = true;
    await tick();
    failNext = true;
    await tick();
    expect((await connection.status("google-health")).error).toContain("Retrying");
    expect(await achieved()).toBe(true);
    await sync();
    expect(await series("sessions")).toMatchObject({ value: null, known: 0 });
    expect(await achieved()).toBe(false);
    exercises = rows(5, 29);
    await sync();
    expect(await achieved()).toBe(true);
    expect((await connectors.request(base, { method: "DELETE" }, testEnv)).status).toBe(204);
    expect(await achieved()).toBe(false);
    expect(await series("sessions")).toMatchObject({ value: null });
  } finally {
    transport.mockRestore();
  }
});
