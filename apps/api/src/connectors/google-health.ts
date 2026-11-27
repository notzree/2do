import { health, type health_v4 } from "@googleapis/health";
import type { OAuth2Client } from "google-auth-library";
import type { RecordedWorkout, WorkoutSource } from "../interfaces/connectors.ts";

function workout(point: health_v4.Schema$ReconciledDataPoint, now: number): RecordedWorkout | null {
  const exercise = point.exercise;
  const start = Date.parse(exercise?.interval?.startTime ?? "");
  const end = Date.parse(exercise?.interval?.endTime ?? "");
  if (
    !point.dataPointName ||
    !exercise?.exerciseType ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  )
    throw new Error("Incomplete Google Health exercise");
  if (end > now || end === start) return null;
  const elapsedMinutes = (end - start) / 60_000;
  const active = exercise.activeDuration;
  const minutes =
    active == null
      ? elapsedMinutes
      : /^\d+(?:\.\d{1,9})?s$/.test(active)
        ? Number(active.slice(0, -1)) / 60
        : NaN;
  const distance = exercise.metricsSummary?.distanceMillimeters;
  if (
    elapsedMinutes < 0 ||
    !Number.isFinite(minutes) ||
    (distance != null && (!Number.isFinite(distance) || distance < 0))
  )
    throw new Error("Invalid Google Health exercise measurements");
  return {
    id: point.dataPointName,
    activity: exercise.exerciseType.toLowerCase().replaceAll("_", " "),
    start: new Date(start).toISOString(),
    elapsedMinutes,
    minutes,
    km: distance == null ? null : distance / 1_000_000,
    running: exercise.exerciseType === "RUNNING",
  };
}

export function googleHealth(auth: OAuth2Client): WorkoutSource {
  const points = health({ version: "v4", auth, timeout: 15_000, retry: false }).users.dataTypes
    .dataPoints;
  return {
    async workouts(from, to, pageToken) {
      const { data } = await points.reconcile({
        parent: "users/me/dataTypes/exercise",
        dataSourceFamily: "users/me/dataSourceFamilies/google-wearables",
        filter: `exercise.interval.civil_start_time >= "${from}" AND exercise.interval.civil_start_time < "${to}"`,
        pageSize: 50,
        pageToken,
        fields:
          "nextPageToken,dataPoints(dataPointName,exercise(exerciseType,interval(startTime,endTime),activeDuration,metricsSummary(distanceMillimeters)))",
      });
      const now = Date.now();
      return {
        workouts: (data.dataPoints ?? []).map((p) => workout(p, now)).filter((row) => row !== null),
        nextPage: data.nextPageToken || undefined,
      };
    },
  };
}
