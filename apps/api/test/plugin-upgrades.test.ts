import { env, runInDurableObject } from "cloudflare:test";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { expect, it } from "vite-plus/test";
import { z } from "zod";
import { Planner } from "../src/core/planner.ts";
import { PluginReports } from "../src/core/plugin-reports.ts";
import { TaskPlugins } from "../src/core/task-plugins.ts";
import { SqlitePlannerDatabase } from "../src/db/planner.ts";
import { SqliteTaskPluginDatabase } from "../src/db/task-plugins.ts";
import { createTask } from "../src/interfaces/plan.ts";
import type { MetricDefinition } from "../src/interfaces/plugin-reports.ts";
import type { TaskPlugin, TaskSubtypeDefinition } from "../src/interfaces/task-plugins.ts";
import type { PluginData } from "../src/interfaces/plugin-workflows.ts";

const minutes: MetricDefinition = {
  id: "study.minutes",
  label: "Study time",
  unit: "min",
  version: 1,
  reducer: "sum",
};
const sessionId = "study.session",
  day = "2026-11-20";

function version(version: 1 | 2): TaskSubtypeDefinition<PluginData, unknown> {
  const v1 = version === 1;
  const dataKey: string = v1 ? "minutes" : "hours";
  const stateKey: string = v1 ? "extra" : "bonus";
  return {
    id: sessionId,
    label: "Study session",
    schemaVersion: version,
    schema: z.strictObject({ [dataKey]: z.number() }),
    initialData: v1 ? { minutes: 0 } : { hours: 0 },
    classification: { instructions: "Is this a study session?", threshold: 0.8 },
    view: (_, data) => data,
    migrations: { 1: (data) => ({ hours: Number(data.minutes) / 60 }) },
    workflow: {
      version,
      initial: v1 ? { extra: 5 } : { bonus: 5 },
      schema: z.strictObject({ [stateKey]: z.number() }),
      commands: [],
      migrations: { 1: (data) => ({ bonus: data.extra }) },
      describe: () => ({ status: "Recorded", actions: [] }),
      transition: (_, __, state) => ({ state }),
      measure: ({ data }, state) => [
        {
          sourceKey: "session",
          metricId: minutes.id,
          metricVersion: minutes.version,
          day,
          value: v1
            ? Number(data.minutes) + Number(state.extra)
            : 60 * Number(data.hours) + Number(state.bonus),
        },
      ],
    },
  };
}

it("upgrades subtype and private workflow data atomically, rebuilds the source once, and preserves opaque rows", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, (_, ctx) => {
    const store = drizzle(ctx.storage);
    const plannerDb = new SqlitePlannerDatabase(store),
      subtypeDb = new SqliteTaskPluginDatabase(store);
    const planner = new Planner(plannerDb);
    function registry(definition: ReturnType<typeof version>) {
      const study: TaskPlugin = {
        id: "study",
        label: "Study",
        subtypes: [definition],
        metrics: [minutes],
      };
      return new TaskPlugins(plannerDb, subtypeDb, [study]);
    }
    const initial = registry(version(1));
    initial.setEnabled("study", true);
    const first = planner.create(createTask.parse({ title: "Study Python" }));
    const rejected = planner.create(createTask.parse({ title: "Return book" }));
    const future = planner.create(createTask.parse({ title: "Review notes" }));
    const old = initial.store(first.id, version(1), "automatic", { minutes: 45 }, first.title);
    const tombstone = initial.write(rejected.id, sessionId, { revision: null, data: null });
    const opaque = {
      typeId: sessionId,
      revision: crypto.randomUUID(),
      schemaVersion: 9,
      source: "manual" as const,
      data: { newer: true },
    };
    subtypeDb.putSubtype(future.id, opaque, null);
    const initialState = initial.workflows.db.state(first.id, sessionId)!;
    const incompatible = version(2);
    incompatible.workflow!.migrations = { 1: () => ({ mistake: true }) };
    expect(() => registry(incompatible).workflows.migrate()).toThrow();
    expect(initial.details(first.id).subtypes[0]).toEqual(old);
    expect(initial.details(rejected.id).subtypes[0]).toEqual(tombstone);
    expect(initial.workflows.db.state(first.id, sessionId)).toEqual(initialState);

    // Simulate an outdated projection. The successful upgrade must derive it afresh.
    initial.workflows.reports.replaceObservations(first.id, sessionId, initialState.revision, []);
    const updated = registry(version(2));
    updated.workflows.migrate();
    const row = updated.details(first.id).subtypes[0];
    expect(row).toMatchObject({ schemaVersion: 2, data: { hours: 0.75 }, source: "automatic" });
    expect(row.revision).not.toEqual(old.revision);
    expect(subtypeDb.subtypes(first.id, "New title")).toEqual([]);
    const newState = updated.workflows.db.state(first.id, sessionId)!;
    expect(newState).toMatchObject({ version: 2, document: { bonus: 5 } });
    expect(newState.revision).not.toEqual(initialState.revision);
    expect(updated.details(rejected.id).subtypes[0]).toMatchObject({
      schemaVersion: 2,
      data: null,
      source: "manual",
    });
    expect(updated.details(future.id).subtypes[0]).toEqual(opaque);
    expect(() =>
      updated.write(first.id, sessionId, { revision: old.revision, data: { hours: 2 } }),
    ).toThrow(/changed/);
    expect(() =>
      updated.write(future.id, sessionId, { revision: opaque.revision, data: { hours: 2 } }),
    ).toThrow(/compatible/);
    const reports = new PluginReports(updated.workflows.reports, updated);
    const bucket = () =>
      reports.series(minutes.id, { from: day, to: "2026-11-21", bucket: "day", weekStart: "0" })
        .buckets[0];
    expect(bucket()).toMatchObject({ value: 50, known: 1, unknown: 0 });
    updated.workflows.migrate();
    expect(updated.details(first.id).subtypes[0]).toEqual(row);
    expect(updated.workflows.db.state(first.id, sessionId)).toEqual(newState);
    expect(bucket()).toMatchObject({ value: 50, known: 1, unknown: 0 });
  });
});

it("initializes pre-workflow attachments and runs independent commands on two subtypes of one task", async () => {
  const stub = env.USER_PLANNER.getByName(crypto.randomUUID());
  await runInDurableObject(stub, async (_, ctx) => {
    const store = drizzle(ctx.storage);
    const plannerDb = new SqlitePlannerDatabase(store);
    const subtypeDb = new SqliteTaskPluginDatabase(store);
    const old = version(1);
    const core = new Planner(plannerDb);
    const task = core.create(createTask.parse({ title: "Read a chapter and review it" }));
    const catalog = (subtypes: TaskPlugin["subtypes"]) =>
      new TaskPlugins(plannerDb, subtypeDb, [
        { id: "study", label: "Study", subtypes, metrics: [minutes] },
      ]);
    const original = catalog([{ ...old, workflow: undefined }]);
    original.setEnabled("study", true);
    original.write(task.id, old.id, { revision: null, data: { minutes: 25 } });

    const definition = {
      ...old,
      workflow: {
        ...old.workflow!,
        commands: [{ id: "next", label: "Next step", fields: [] }],
        describe: (_current: unknown, state: PluginData) => ({
          status: String(state.extra),
          actions: state.extra === 5 ? [{ id: "next" }] : [],
        }),
        transition: (
          _previous: unknown,
          _current: unknown,
          state: PluginData,
          event: { kind: string },
        ) => ({ state: event.kind === "command" ? { extra: 10 } : state }),
      },
    };
    const reviewId = "study.review";
    const upgraded = catalog([definition, { ...definition, id: reviewId }]);
    upgraded.workflows.migrate();
    const firstState = upgraded.workflows.db.state(task.id, old.id)!;
    upgraded.workflows.migrate();
    expect(upgraded.workflows.db.state(task.id, old.id)).toEqual(firstState);
    const report = new PluginReports(upgraded.workflows.reports, upgraded);
    const total = () =>
      report.series(minutes.id, { from: day, to: "2026-11-21", bucket: "day", weekStart: "0" })
        .buckets[0].value;
    expect(total()).toBe(30);
    upgraded.write(task.id, reviewId, { revision: null, data: { minutes: 5 } });
    const read = () => upgraded.details(task.id).workflows!;
    for (const id of [old.id, reviewId]) {
      const current = read().find((w) => w.typeId === id)!;
      expect(current.actions.map((a) => a.id)).toEqual(["next"]);
      await upgraded.workflows.command(
        task.id,
        id,
        "next",
        {
          commandId: crypto.randomUUID(),
          installationEpoch: current.installationEpoch,
          taskRevision: current.taskRevision,
          subtypeRevision: current.subtypeRevision,
          workflowRevision: current.workflowRevision,
          input: {},
        },
        async (write) => plannerDb.transaction(write),
      );
      expect(read().find((w) => w.typeId === id)?.actions).toEqual([]);
    }
    expect(total()).toBe(50);
  });
});
