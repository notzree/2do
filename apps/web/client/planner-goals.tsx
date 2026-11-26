import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient, queryOptions } from "@tanstack/react-query";
import {
  plannerGoal,
  type PlannerGoal,
  type GoalChange,
  type GoalType,
  type GoalConfig,
} from "@2do/api/goals";
import { plan } from "@2do/api/plan";
import { api, planKey } from "./query.ts";
import { useTaskPlugins } from "./task-plugin-api.ts";
import { Modal } from "./modal.tsx";

const plannerGoalsQuery = queryOptions({
  queryKey: ["planner", "reports", "planner-goals"],
  queryFn: async ({ signal }) =>
    plannerGoal.array().parse((await api.GET("/api/planner-goals", { signal })).data),
});
function useGoalChange(goal: PlannerGoal) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (change: GoalChange) =>
      plannerGoal.parse(
        (
          await api.PATCH("/api/planner-goals/{id}", {
            params: { path: { id: goal.id } },
            body: { revision: goal.revision, change },
          })
        ).data,
      ),
    onSuccess: (updated) =>
      client.setQueryData(plannerGoalsQuery.queryKey, (old: PlannerGoal[] | undefined) =>
        old?.map((g) => (g.id === updated.id ? updated : g)),
      ),
    onSettled: () => client.invalidateQueries({ queryKey: ["planner", "reports"] }),
  });
}
function Criteria({ type, data }: { type: GoalType; data: GoalConfig }) {
  return (
    <>
      {type.fields.map((f) => (
        <label key={f.key}>
          {f.label}
          {f.kind === "choice" ? (
            <select name={"field-" + f.key} defaultValue={data[f.key] ?? ""} required>
              <option value="">Choose…</option>
              {f.options.map((v) => (
                <option key={v}>{v}</option>
              ))}
            </select>
          ) : (
            <input
              name={"field-" + f.key}
              required
              defaultValue={data[f.key] ?? ""}
              type={f.kind}
              min={f.kind === "number" ? f.min : undefined}
              step={f.kind === "number" && !f.integer ? "any" : undefined}
            />
          )}
        </label>
      ))}
    </>
  );
}
function GoalForm({
  goal,
  types,
  close,
}: {
  goal?: PlannerGoal;
  types: GoalType[];
  close: () => void;
}) {
  const [id] = useState(() => crypto.randomUUID());
  const [typeId, select] = useState(goal?.subtype?.typeId ?? "");
  const type = types.find((t) => t.id === typeId);
  const client = useQueryClient();
  const save = useMutation({
    mutationFn: async (form: FormData) => {
      const title = String(form.get("title")).trim(),
        targetDate = String(form.get("targetDate") ?? "") || null,
        nextCheckIn = String(form.get("nextCheckIn") ?? "") || null;
      const data: GoalConfig = {};
      for (const f of type?.fields ?? [])
        data[f.key] =
          f.kind === "number"
            ? Number(form.get("field-" + f.key))
            : String(form.get("field-" + f.key));
      const subtype = type ? { typeId: type.id, version: type.version, data } : null;
      if (goal)
        return api.PATCH("/api/planner-goals/{id}", {
          params: { path: { id: goal.id } },
          body: {
            revision: goal.revision,
            change: {
              action: "edit",
              title,
              targetDate,
              nextCheckIn,
              ...((type || !typeId) && { subtype }),
            },
          },
        });
      return api.POST("/api/planner-goals", {
        body: { id, title, targetDate, nextCheckIn, ...(subtype && { subtype }) },
      });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["planner", "reports"] });
      close();
    },
    onError: () => client.invalidateQueries({ queryKey: plannerGoalsQuery.queryKey }),
  });
  return (
    <Modal title={goal ? "Edit goal" : "New goal"} close={close}>
      <form
        className="report-form"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(new FormData(e.currentTarget));
        }}
      >
        <label>
          Goal
          <input
            name="title"
            maxLength={goal?.dailyMetric ? 120 : 240}
            autoFocus
            required
            defaultValue={goal?.title}
            placeholder="Feel ready for interviews"
          />
        </label>
        <div className="report-toolbar">
          <label>
            Target date
            <input name="targetDate" type="date" defaultValue={goal?.targetDate ?? ""} />
          </label>
          <label>
            Next check-in
            <input name="nextCheckIn" type="date" defaultValue={goal?.nextCheckIn ?? ""} />
          </label>
        </div>
        {!goal?.dailyMetric && (
          <label>
            Progress rule
            <select value={typeId} onChange={(e) => select(e.target.value)}>
              <option value="">Personal judgment</option>
              {typeId && !type && <option value={typeId}>{typeId} (unavailable)</option>}
              {types.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {type && (
          <Criteria
            key={type.id}
            type={type}
            data={goal?.subtype?.typeId === type.id ? goal.subtype.data : {}}
          />
        )}
        {save.error && (
          <p className="error" role="alert">
            {save.error.message}
          </p>
        )}
        <button className="primary" disabled={save.isPending}>
          Save goal
        </button>
      </form>
    </Modal>
  );
}
function GoalInspector({ goal, edit }: { goal: PlannerGoal; edit: () => void }) {
  const change = useGoalChange(goal);
  const tasks = useQuery({
    queryKey: planKey,
    queryFn: async ({ signal }) => plan.parse((await api.GET("/api/tasks", { signal })).data),
  });
  const [note, setNote] = useState("");
  const [reviewDay, setReviewDay] = useState("");
  const progress = useQuery({
    queryKey: ["planner", "reports", "goal-progress", goal.id, reviewDay],
    enabled: !!reviewDay,
    queryFn: async ({ signal }) =>
      (
        await api.GET("/api/planner-goals/{id}/progress", {
          params: { path: { id: goal.id }, query: { day: reviewDay } },
          signal,
        })
      ).data ?? null,
  });
  function link(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    change.mutate({
      action: "link",
      taskId: String(f.get("task")),
      role: f.get("role") === "satisfies" ? "satisfies" : "contributes",
    });
  }
  return (
    <div className="goal-detail">
      <div className="report-toolbar">
        <button onClick={edit}>Edit goal</button>
        {(goal.manualAchievement || !goal.achieved) && (
          <button
            disabled={change.isPending}
            onClick={() =>
              change.mutate({ action: "achievement", achieved: !goal.manualAchievement })
            }
          >
            {goal.manualAchievement ? "Reopen goal" : "Mark achieved"}
          </button>
        )}
      </div>
      {(goal.subtype || goal.dailyMetric) && (
        <label>
          Review progress on{" "}
          <input type="date" value={reviewDay} onChange={(e) => setReviewDay(e.target.value)} />
        </label>
      )}
      {reviewDay && (
        <p>
          {progress.error?.message ??
            progress.data?.label ??
            (progress.isPending ? "Loading progress…" : "No rule data available")}
        </p>
      )}
      <h3>Linked tasks</h3>
      <ul>
        {goal.links.map((l) => (
          <li key={l.taskId}>
            {l.completed ? "✓ " : ""}
            {l.title} · {l.role === "satisfies" ? "Completes goal" : "Contributes"}{" "}
            <button
              disabled={change.isPending}
              aria-label={"Unlink " + l.title}
              onClick={() => change.mutate({ action: "link", taskId: l.taskId, role: null })}
            >
              Unlink
            </button>
          </li>
        ))}
      </ul>
      {tasks.data?.tasks.length ? (
        <form onSubmit={link} className="report-toolbar">
          <select name="task" aria-label="Task to link" required defaultValue="">
            <option value="">Choose a task</option>
            {tasks.data.tasks.map((t) => (
              <option value={t.id} key={t.id}>
                {t.title}
              </option>
            ))}
          </select>
          <select name="role" aria-label="Link role">
            <option value="contributes">Contributes</option>
            <option value="satisfies">Completes goal</option>
          </select>
          <button disabled={change.isPending}>Save link</button>
        </form>
      ) : (
        <p>{tasks.error?.message ?? "Capture a task to link it here."}</p>
      )}
      <h3>Check-ins</h3>
      {goal.checkIns.map((c, i) => (
        <p key={i}>
          <time dateTime={c.at}>{new Date(c.at).toLocaleDateString()}</time> · {c.note}
        </p>
      ))}
      <form
        className="report-form"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          change.mutate(
            { action: "check-in", note, nextCheckIn: String(f.get("next") ?? "") || null },
            { onSuccess: () => setNote("") },
          );
        }}
      >
        <label>
          Progress note
          <textarea
            required
            maxLength={2000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <label>
          Next check-in
          <input
            name="next"
            type="date"
            defaultValue={goal.nextCheckIn ?? ""}
            key={goal.nextCheckIn}
          />
        </label>
        <button disabled={change.isPending}>Record check-in</button>
      </form>
      {change.error && (
        <p role="alert" className="error">
          {change.error.message}
        </p>
      )}
    </div>
  );
}
export function PlannerGoalPanel() {
  const goals = useQuery(plannerGoalsQuery);
  const { plugins } = useTaskPlugins();
  const types = (plugins ?? []).filter((p) => p.enabled).flatMap((p) => p.goalSubtypes ?? []);
  const [editing, setEditing] = useState<PlannerGoal | "new" | null>(null);
  const [expanded, setExpanded] = useState("");
  return (
    <section className="goal-settings planner-goals">
      <div className="section-head">
        <h2>Goals</h2>
        <button onClick={() => setEditing("new")}>New goal</button>
      </div>
      {goals.error && (
        <p className="error" role="alert">
          {goals.error.message} <button onClick={() => goals.refetch()}>Retry</button>
        </p>
      )}
      {goals.data?.map((g) => (
        <article key={g.id}>
          <button
            className="goal-summary"
            aria-expanded={expanded === g.id}
            onClick={() => setExpanded(expanded === g.id ? "" : g.id)}
          >
            <strong>{g.title}</strong>
            <span>{g.achieved ? "Achieved" : "Active"}</span>
          </button>
          {g.targetDate && <small>Due {g.targetDate} </small>}
          {g.nextCheckIn && <small>Check in {g.nextCheckIn}</small>}
          {g.progress ? (
            <p>{g.progress.label}</p>
          ) : g.subtype ? (
            <p>Enable a compatible plugin to see progress.</p>
          ) : g.dailyMetric ? (
            <p>Daily target · {g.dailyMetric}</p>
          ) : null}
          {expanded === g.id && <GoalInspector goal={g} edit={() => setEditing(g)} />}
        </article>
      ))}
      {editing && (
        <GoalForm
          goal={editing === "new" ? undefined : editing}
          types={types}
          close={() => setEditing(null)}
        />
      )}
    </section>
  );
}

export function GoalReference({ id }: { id: string }) {
  const query = useQuery(plannerGoalsQuery),
    { plugins } = useTaskPlugins();
  const goal = query.data?.find((g) => g.id === id);
  const [mode, setMode] = useState<"closed" | "view" | "edit">("closed");
  return (
    <>
      <button disabled={!goal} onClick={() => setMode("view")}>
        {goal?.achieved ? "✓ " : ""}
        {goal?.title ?? "Saving goal…"}
      </button>
      {goal && mode === "view" && (
        <Modal title={goal.title} close={() => setMode("closed")}>
          <p>{goal.progress?.label ?? (goal.achieved ? "Achieved" : "Active")}</p>
          <GoalInspector goal={goal} edit={() => setMode("edit")} />
        </Modal>
      )}
      {goal && mode === "edit" && (
        <GoalForm
          goal={goal}
          types={(plugins ?? []).filter((p) => p.enabled).flatMap((p) => p.goalSubtypes ?? [])}
          close={() => setMode("view")}
        />
      )}
    </>
  );
}

export function TaskGoalLinks({ taskId }: { taskId: string }) {
  const [opened, open] = useState(false),
    [id, select] = useState("");
  const goals = useQuery({ ...plannerGoalsQuery, enabled: opened });
  const chosen = goals.data?.find((g) => g.id === id);
  return (
    <details className="inspector-section" onToggle={(e) => open(e.currentTarget.open)}>
      <summary>Goal links</summary>
      {goals.error && <p role="alert">{goals.error.message}</p>}
      {goals.data
        ?.filter((g) => g.links.some((l) => l.taskId === taskId))
        .map((g) => (
          <p key={g.id}>
            {g.title} · {g.links.find((l) => l.taskId === taskId)?.role}
          </p>
        ))}
      <label>
        Goal{" "}
        <select value={id} onChange={(e) => select(e.target.value)}>
          <option value="">Choose a goal</option>
          {goals.data?.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
      </label>
      {chosen && <TaskLinkActions goal={chosen} taskId={taskId} />}
    </details>
  );
}
function TaskLinkActions({ goal, taskId }: { goal: PlannerGoal; taskId: string }) {
  const change = useGoalChange(goal),
    link = goal.links.find((l) => l.taskId === taskId);
  return (
    <div className="report-toolbar">
      {(["contributes", "satisfies"] as const).map((role) => (
        <button
          key={role}
          disabled={change.isPending || link?.role === role}
          onClick={() => change.mutate({ action: "link", role, taskId })}
        >
          {role === "contributes" ? "Contributes" : "Completes goal"}
        </button>
      ))}
      {link && (
        <button
          disabled={change.isPending}
          onClick={() => change.mutate({ action: "link", role: null, taskId })}
        >
          Unlink
        </button>
      )}
      {change.error && <p role="alert">{change.error.message}</p>}
    </div>
  );
}
