import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Check, PanelRight, X } from "lucide-react";
import { taskCapture } from "@2do/api/notebook";
import { kind, type Task, type Plan } from "@2do/api/plan";
import { dayKey, scheduleStart, timeRange } from "./calendar.ts";
import { DependencyGraph } from "./graph.tsx";
import type { Mutate } from "./use-plan.ts";
import { api } from "./query.ts";
import { InspectorPrompt, SkippedHints, useInspectorPrompts } from "./task-hints.tsx";
import { ProposeTime } from "./review-inbox.tsx";
import { TaskSubtypes } from "./task-subtypes.tsx";
import { taskForm, prepareTaskEdit, type TaskForm } from "./task-edits.ts";
import "./task-inspector.css";

function TaskEditor({
  task,
  plan,
  day,
  mutate,
  busy,
}: {
  task: Task;
  plan: Plan;
  day: string;
  mutate: Mutate;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<{ base: Task; form: TaskForm }>();
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const form = draft?.form ?? taskForm(task, day);
  const { title, type, date, start, end, taskKind, parent, duration } = form;
  function edit<K extends keyof TaskForm>(key: K, value: TaskForm[K]) {
    setDraft({ base: draft?.base ?? task, form: { ...form, [key]: value } });
    setSaved(false);
    setConflict(false);
  }
  const stale = draft && draft.base.revision !== task.revision;
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!draft) return;
    const edit = prepareTaskEdit(draft.base, form, task);
    if (edit.status === "conflict") {
      setConflict(true);
      return;
    }
    if (edit.status === "unchanged" || (await mutate.updateTask(task.id, edit.patch))) {
      setDraft(undefined);
      setConflict(false);
      setSaved(true);
    }
  }
  return (
    <form className="editor" onSubmit={save}>
      <fieldset className="task-editor-fields" disabled={busy}>
        <label>
          Title
          <input
            data-edit-title
            required
            maxLength={240}
            value={title}
            onChange={(e) => edit("title", e.target.value)}
          />
        </label>
        <div className="field-pair">
          <label>
            Kind
            <select value={taskKind} onChange={(e) => edit("taskKind", kind.parse(e.target.value))}>
              {kind.options.map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label>
            Duration (minutes)
            <input
              type="number"
              min="1"
              max="525600"
              value={duration}
              onChange={(e) => edit("duration", e.target.value)}
            />
          </label>
        </div>
        <label>
          Schedule
          <select value={type} onChange={(e) => edit("type", e.target.value as typeof type)}>
            <option value="none">Unscheduled</option>
            <option value="day">Anytime on a day</option>
            <option value="fixed">Fixed time</option>
            <option value="window">Flexible window</option>
          </select>
        </label>
        {type === "day" && (
          <label>
            Day
            <input
              type="date"
              required
              value={date}
              onChange={(e) => edit("date", e.target.value)}
            />
          </label>
        )}
        {(type === "fixed" || type === "window") && (
          <div className="field-pair">
            <label>
              Start
              <input
                type="datetime-local"
                required
                value={start}
                onChange={(e) => edit("start", e.target.value)}
              />
            </label>
            <label>
              End
              <input
                type="datetime-local"
                required
                min={start}
                value={end}
                onChange={(e) => edit("end", e.target.value)}
              />
            </label>
          </div>
        )}
        <label>
          Parent task
          <select value={parent} onChange={(e) => edit("parent", e.target.value)}>
            <option value="">Top level</option>
            {plan.tasks
              .filter((t) => t.id !== task.id)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
          </select>
        </label>
        <div className="actions">
          <button type="submit" className="primary" disabled={busy || !draft || !title.trim()}>
            Save changes
          </button>
          {saved && <small role="status">Saved</small>}
          {stale && (
            <button
              type="button"
              onClick={() => {
                setDraft(undefined);
                setConflict(false);
              }}
            >
              Load latest task
            </button>
          )}
          {conflict && (
            <small role="alert">
              An edited field also changed elsewhere. Load the latest task to review it.
            </small>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function OriginalInput({ id }: { id: string }) {
  const capture = useQuery({
    queryKey: ["planner", "capture", id],
    queryFn: async ({ signal }) =>
      taskCapture
        .nullable()
        .parse(
          (await api.GET("/api/tasks/{id}/capture", { params: { path: { id } }, signal })).data,
        ),
    staleTime: Infinity,
  });
  return (
    <section className="inspector-source" aria-label="Original input">
      <h3>Original input</h3>
      {capture.isPending ? (
        <small role="status">Loading original input…</small>
      ) : capture.isError ? (
        <div role="alert">
          {capture.error.message}{" "}
          <button type="button" onClick={() => void capture.refetch()}>
            Retry
          </button>
        </div>
      ) : capture.data ? (
        <>
          <pre>{capture.data.rawInput}</pre>
          <small>
            Notebook · <time dateTime={capture.data.notebookDate}>{capture.data.notebookDate}</time>
          </small>
        </>
      ) : (
        <small>No original input recorded.</small>
      )}
    </section>
  );
}

export function TaskInspector({
  plan,
  task,
  graph,
  showGraph,
  select,
  close,
  openPlugins,
  mutate,
  busy,
  error,
  day,
}: {
  plan: Plan;
  task: Task;
  graph: boolean;
  showGraph: (v: boolean) => void;
  select: (id: string) => void;
  close: () => void;
  openPlugins: () => void;
  mutate: Mutate;
  busy: boolean;
  error: string;
  day: string;
}) {
  const [sub, setSub] = useState(""),
    [prereq, setPrereq] = useState("");
  const before = plan.edges.filter((e) => e.to === task.id).map((e) => e.from);
  const prompts = useInspectorPrompts(task.id);
  const children = plan.tasks.filter((t) => t.parentId === task.id);
  return (
    <aside
      id="task-inspector"
      className="task-inspector"
      aria-label="Task inspector"
      tabIndex={-1}
      onKeyDown={(event) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          event.currentTarget.querySelector("dialog[open]")
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <header className="inspector-head">
        <PanelRight size={16} aria-hidden="true" />
        <strong>Task inspector</strong>
        <button
          type="button"
          className="plain"
          aria-label="Close task inspector"
          title="Close (Esc)"
          onClick={close}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </header>
      <div className="inspector-body">
        <p className="inspector-id">
          {task.kind} / #{task.id.slice(0, 6)}
        </p>
        <h2>{task.title}</h2>
        <dl className="inspector-metadata">
          <div>
            <dt>Status</dt>
            <dd>{task.completed ? "Done" : "Open"}</dd>
          </div>
          {task.schedule && (
            <div>
              <dt>Scheduled</dt>
              <dd>
                {scheduleStart(task.schedule).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
                {timeRange(task) && " · " + timeRange(task)}
              </dd>
            </div>
          )}
        </dl>
        <div className="switcher inspector-tabs">
          <button aria-pressed={!graph} onClick={() => showGraph(false)}>
            Details
          </button>
          <button aria-pressed={graph} onClick={() => showGraph(true)}>
            Graph
          </button>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {graph && <DependencyGraph plan={plan} task={task} select={select} />}
        <div hidden={graph}>
          <OriginalInput id={task.id} />
          <TaskSubtypes
            task={task}
            active={!graph}
            openPlugins={openPlugins}
            renderPrompts={(typeId) =>
              prompts
                .filter((p) => p.typeId === typeId && !p.skipped)
                .map((p) => <InspectorPrompt key={p.id} task={task} prompt={p} />)
            }
          />
          <SkippedHints taskId={task.id} prompts={prompts} />
          <details className="inspector-section">
            <summary>Edit task</summary>
            <TaskEditor task={task} plan={plan} day={day} mutate={mutate} busy={busy} />
          </details>
          {task.schedule?.type === "fixed" && <ProposeTime task={task} />}
          <details className="inspector-section">
            <summary>Relationships</summary>
            <h3>Subtasks</h3>
            {children.map((t) => (
              <button className="relation" key={t.id} onClick={() => select(t.id)}>
                {t.completed ? "✓ " : ""}
                {t.title} ›
              </button>
            ))}
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (
                  await mutate.createTask({
                    title: sub,
                    parentId: task.id,
                    schedule: task.schedule
                      ? {
                          type: "day",
                          date:
                            task.schedule.type === "day"
                              ? task.schedule.date
                              : dayKey(new Date(task.schedule.start)),
                        }
                      : null,
                  })
                )
                  setSub("");
              }}
            >
              <input
                aria-label="Subtask title"
                placeholder="Subtask title"
                value={sub}
                maxLength={240}
                onChange={(e) => setSub(e.target.value)}
              />
              <button type="submit" disabled={busy || !sub.trim()}>
                Add subtask
              </button>
            </form>
            <h3>Prerequisites</h3>
            {before.map((id) => (
              <div className="section-head" key={id}>
                <button className="relation" onClick={() => select(id)}>
                  {plan.tasks.find((t) => t.id === id)?.title}
                </button>
                <button
                  className="plain"
                  disabled={busy}
                  onClick={() => void mutate.removeDependency(id, task.id)}
                >
                  Unlink
                </button>
              </div>
            ))}
            <form
              className="inline-form"
              onSubmit={async (e) => {
                e.preventDefault();
                if (prereq && (await mutate.addDependency(prereq, task.id))) setPrereq("");
              }}
            >
              <select
                aria-label="Prerequisite task"
                value={prereq}
                onChange={(e) => setPrereq(e.target.value)}
              >
                <option value="">Choose task…</option>
                {plan.tasks
                  .filter((t) => t.id !== task.id && !before.includes(t.id))
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
              <button type="submit" disabled={busy || !prereq}>
                Add prerequisite
              </button>
            </form>
          </details>
          <div className="inspector-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void mutate.updateTask(task.id, {
                  revision: task.revision,
                  completed: !task.completed,
                })
              }
            >
              <Check size={13} aria-hidden="true" />
              {task.completed ? "Reopen" : "Complete"}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={async () => {
                if (
                  window.confirm(
                    "Delete this task, its notebook references, and its prerequisite links? Its subtasks will be kept.",
                  ) &&
                  (await mutate.deleteTask(task.id))
                )
                  close();
              }}
            >
              Delete task
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
