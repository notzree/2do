import type { RecordedWorkout, WorkoutSource } from "../interfaces/connectors.ts";

const day = 86_400_000;
const dateAt = (time: number) => new Date(time).toISOString().slice(0, 10);

type Scan = {
  id: string;
  epoch: string;
  earliest: string;
  from: string;
  to: string;
  page?: string;
};
function windowEnding(to: string, earliest: string) {
  const from = dateAt(Date.parse(to) - 30 * day);
  return from < earliest ? earliest : from;
}

// Persist the frozen civil-date window and page cursor. A lost planner RPC response is
// safe to replay. Only the last page of the oldest window may remove missing records.
export async function importWorkoutPage(
  kv: DurableObjectStorage["kv"],
  source: WorkoutSource,
  installed: number,
  epoch: string,
  apply: (scan: string, workouts: RecordedWorkout[], complete: boolean) => Promise<boolean>,
) {
  let scan = kv.get<Scan>("workout-scan");
  if (!scan || scan.epoch !== epoch) {
    const earliest = dateAt(installed - 30 * day);
    const to = dateAt(Date.now() + 2 * day); // Includes today's civil date on both sides of UTC.
    scan = { id: crypto.randomUUID(), epoch, earliest, to, from: windowEnding(to, earliest) };
    kv.put("workout-scan", scan);
  }
  const page = await source.workouts(scan.from, scan.to, scan.page);
  const complete = !page.nextPage && scan.from === scan.earliest;
  if (!(await apply(scan.id, page.workouts, complete))) {
    kv.delete("workout-scan");
    return "paused";
  }
  if (complete) {
    kv.delete("workout-scan");
    return "complete";
  }
  kv.put(
    "workout-scan",
    page.nextPage
      ? { ...scan, page: page.nextPage }
      : { ...scan, to: scan.from, from: windowEnding(scan.from, scan.earliest), page: undefined },
  );
  return "continue";
}
