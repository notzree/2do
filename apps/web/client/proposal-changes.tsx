import type { InboxChange, InboxItem } from "@2do/api/agent-inbox";
import { dueDate, schedule, type Plan } from "@2do/api/plan";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { planQuery } from "./use-plan.ts";

type Titles = Readonly<Record<string, string>>;
type Group = { taskId?: string; changes: InboxChange[] };

const taskField =
  /^(task|task_classification) ([\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12})(?: · (.+))?$/i;
const labels: Record<string, string> = {
  currentDay: "Notebook day",
  schedule: "Schedule",
  due: "Due date",
  completed: "Status",
  parentId: "Parent task",
  durationMinutes: "Duration",
  carriedFrom: "Carried from",
  siblingOrder: "Subtask order",
  createdDate: "Created on",
  id: "ID",
};

function label(key: string) {
  const text = key.replaceAll("_", " ").replace(/([a-z])([A-Z])/g, "$1 $2");
  return Object.hasOwn(labels, key) ? labels[key] : text.charAt(0).toUpperCase() + text.slice(1);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function groupChanges(changes: InboxChange[]) {
  const groups: Group[] = [];
  const tasks = new Map<string, Group>();
  for (const change of changes) {
    const match = taskField.exec(change.field);
    if (!match) {
      groups.push({ changes: [change] });
      continue;
    }
    const [, entity, taskId, property] = match;
    let group = tasks.get(taskId);
    if (!group) {
      group = { taskId, changes: [] };
      tasks.set(taskId, group);
      groups.push(group);
    }
    group.changes.push({
      ...change,
      field: entity === "task_classification" ? "Task classification" : (property ?? ""),
    });
  }
  return groups;
}

function notebookDay(value: unknown) {
  if (value == null) return null;
  if (record(value) && value.type === "day" && typeof value.date === "string") return value.date;
  return undefined;
}

// Pair one notebook-day write with one all-day schedule write only when both endpoints agree.
function taskRows(changes: InboxChange[]) {
  const schedules = changes.filter((c) => c.field === "schedule");
  return changes.filter((c) => {
    if (c.field !== "currentDay") return true;
    const i = schedules.findIndex(
      (s) => notebookDay(s.before) === c.before && notebookDay(s.after) === c.after,
    );
    if (i < 0) return true;
    schedules.splice(i, 1);
    return false;
  });
}

const dayFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
const dateFields = new Set([
  "currentDay",
  "date",
  "createdDate",
  "carriedFrom",
  "day",
  "endDateExclusive",
  "schedule",
  "due",
]);
const civilDate = /^\d{4}-\d{2}-\d{2}$/;
function dateOnly(text: string) {
  const day = new Date(text + "T00:00:00Z");
  return Number.isFinite(+day) ? dayFormat.format(day) : text;
}

function calendarValue(value: Record<string, unknown>) {
  const parsed = schedule.safeParse(value);
  if (parsed.success) {
    const s = parsed.data;
    if (s.type === "day") {
      if (!s.endDateExclusive) return dateOnly(s.date);
      const first = new Date(s.date + "T00:00:00Z"),
        last = new Date(s.endDateExclusive + "T00:00:00Z");
      last.setUTCDate(last.getUTCDate() - 1);
      return dayFormat.formatRange(first, last);
    }
    const range = timeFormat.formatRange(new Date(s.start), new Date(s.end));
    return s.type === "window" ? "Available " + range : range;
  }
  const due = dueDate.safeParse(value);
  if (due.success && due.data.type === "time") {
    const d = due.data;
    return new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
      timeZone: d.timeZone,
    }).format(new Date(d.at));
  }
  if (
    Object.keys(value).length === 2 &&
    typeof value.start === "string" &&
    typeof value.end === "string"
  ) {
    const start = new Date(value.start),
      end = new Date(value.end);
    if (Number.isFinite(+start) && Number.isFinite(+end) && start <= end)
      return timeFormat.formatRange(start, end);
  }
}

function ValueFields({ value, titles }: { value: Record<string, unknown>; titles: Titles }) {
  return (
    <dl className="change-fields">
      {Object.entries(value).map(([key, v]) => (
        <div key={key}>
          <dt>{label(key)}</dt>
          <dd>
            <Value value={v} field={key} titles={titles} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Value({ value, field, titles }: { value: unknown; field: string; titles: Titles }) {
  if (value == null) return <>None</>;
  if (typeof value === "boolean")
    return <>{field === "completed" ? (value ? "Completed" : "Open") : value ? "Yes" : "No"}</>;
  if (typeof value === "number")
    return (
      <>
        {value}
        {field === "durationMinutes" ? " min" : ""}
      </>
    );
  if (typeof value === "string") {
    if (field === "Notebook selection" && value.startsWith("[")) {
      try {
        const nodes: unknown = JSON.parse(value);
        if (Array.isArray(nodes)) return <Value value={nodes} field="Content" titles={titles} />;
      } catch {
        /* Plain notebook text. */
      }
    }
    if (dateFields.has(field) && civilDate.test(value)) return <>{dateOnly(value)}</>;
    if (field === "parentId" && titles[value]) return <>{titles[value]}</>;
    return <>{value || "Blank"}</>;
  }
  if (Array.isArray(value))
    return value.length ? (
      <ul className="change-values">
        {value.map((v, i) => (
          <li key={i}>
            <Value value={v} field={field} titles={titles} />
          </li>
        ))}
      </ul>
    ) : (
      <>No items</>
    );
  if (!record(value)) return <>{String(value)}</>;
  const calendar = calendarValue(value);
  if (calendar) return <>{calendar}</>;
  if (!Object.keys(value).length) return <>No fields set</>;
  return <ValueFields value={value} titles={titles} />;
}

function empty(value: unknown) {
  return value == null || value === "" || (Array.isArray(value) && !value.length);
}

function ChangeLine({
  kind,
  children,
  fieldLabel,
}: {
  fieldLabel?: string;
  kind: "added" | "removed" | "before" | "after" | "context";
  children: ReactNode;
}) {
  const marks = { added: "+", removed: "−", before: "From", after: "To", context: "" };
  return (
    <div className="change-line" data-kind={kind}>
      {marks[kind] && (
        <span className="change-mark" aria-hidden="true">
          {marks[kind]}
        </span>
      )}
      <span className="change-accessible">
        {
          {
            added: "Added",
            removed: "Removed",
            before: "Before",
            after: "After",
            context: "Current value",
          }[kind]
        }{" "}
      </span>
      {fieldLabel && (
        <span className="change-field-name">
          {fieldLabel}
          <span aria-hidden="true"> ·</span>
        </span>
      )}
      <div className="change-value">{children}</div>
    </div>
  );
}

function TaskRecord({
  value,
  kind,
  titles,
}: {
  value: Record<string, unknown>;
  kind: "added" | "removed";
  titles: Titles;
}) {
  const facts: ReactNode[] = [];
  if (value.kind && value.kind !== "task") facts.push(label(String(value.kind)));
  if (value.completed === true) facts.push("Completed");
  if (value.schedule) facts.push(<Value value={value.schedule} field="schedule" titles={titles} />);
  if (value.currentDay && value.currentDay !== notebookDay(value.schedule))
    facts.push(
      <>
        Notebook · <Value value={value.currentDay} field="currentDay" titles={titles} />
      </>,
    );
  if (value.due)
    facts.push(
      <>
        Due <Value value={value.due} field="due" titles={titles} />
      </>,
    );
  if (value.durationMinutes != null)
    facts.push(<Value value={value.durationMinutes} field="durationMinutes" titles={titles} />);
  if (typeof value.parentId === "string")
    facts.push(titles[value.parentId] ? "Subtask of " + titles[value.parentId] : "Subtask");
  return (
    <>
      <ChangeLine kind={kind}>
        <strong className="change-task">{String(value.title)}</strong>
      </ChangeLine>
      {facts.length > 0 && (
        <ul className="change-task-facts">
          {facts.map((fact, i) => (
            <li key={i}>{fact}</li>
          ))}
        </ul>
      )}
    </>
  );
}

function classificationRequest(value: unknown) {
  return (
    value === true || (record(value) && Object.keys(value).length === 1 && value.requested === true)
  );
}

function Row({ change, titles }: { change: InboxChange; titles: Titles }) {
  const { field, before, after } = change;
  if (!field && before == null && record(after) && typeof after.title === "string")
    return <TaskRecord value={after} kind="added" titles={titles} />;
  if (!field && after == null && record(before) && typeof before.title === "string")
    return <TaskRecord value={before} kind="removed" titles={titles} />;
  if (field === "Task classification") {
    if (empty(before) && classificationRequest(after))
      return <small className="change-note">Automatic classification requested</small>;
    if (classificationRequest(before) && empty(after))
      return <small className="change-note">Classification request removed</small>;
  }
  function show(value: unknown) {
    if (record(value) && typeof value.title === "string") {
      const when = record(value.schedule) && calendarValue(value.schedule);
      return (
        <details className="change-record">
          <summary>
            {value.title}
            {when ? " · " + when : ""}
          </summary>
          <ValueFields value={value} titles={titles} />
        </details>
      );
    }
    return <Value value={value} field={field} titles={titles} />;
  }
  const caption =
    field &&
    label(field.replace(/[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}/gi, (id) => titles[id] ?? id));
  if (empty(before) && !empty(after))
    return (
      <ChangeLine kind="added" fieldLabel={caption}>
        {show(after)}
      </ChangeLine>
    );
  if (!empty(before) && empty(after))
    return (
      <ChangeLine kind="removed" fieldLabel={caption}>
        {show(before)}
      </ChangeLine>
    );
  const lines =
    JSON.stringify(before) === JSON.stringify(after) ? (
      <ChangeLine kind="context">{show(after)}</ChangeLine>
    ) : (
      <>
        <ChangeLine kind="before">{show(before)}</ChangeLine>
        <ChangeLine kind="after">{show(after)}</ChangeLine>
      </>
    );
  return (
    <div className="change-row">
      {caption && <span className="change-label">{caption}</span>}
      <div>{lines}</div>
    </div>
  );
}

function recordedTitle(changes: InboxChange[]) {
  for (const { field, before, after } of changes) {
    if (field === "title" && typeof before === "string") return before;
    if (!field) {
      const item = before ?? after;
      if (record(item) && typeof item.title === "string") return item.title;
    }
  }
}

function TaskName({ id, fields, titles }: { id: string; fields: InboxChange[]; titles: Titles }) {
  const name = recordedTitle(fields) ?? titles[id];
  return name ? (
    <strong className="change-task">{name}</strong>
  ) : (
    <strong className="change-task">Unavailable task</strong>
  );
}

export function ProposalChanges({
  changes,
  titles = {},
}: {
  changes: InboxChange[];
  titles?: Titles;
}) {
  if (!changes.length) return null;
  return (
    <ul className="proposal-changes" aria-label="Changes">
      {groupChanges(changes).map(({ taskId, changes: fields }, i) => {
        // A whole-task diff already names the task inside the signed row.
        const hasTaskRecord = fields.some((c) => {
          const value = c.before ?? c.after;
          return !c.field && record(value) && typeof value.title === "string";
        });
        return (
          <li key={taskId ?? i}>
            {taskId && !hasTaskRecord && <TaskName id={taskId} fields={fields} titles={titles} />}
            {(taskId ? taskRows(fields) : fields).map((change, j) => (
              <Row key={j} change={change} titles={titles} />
            ))}
          </li>
        );
      })}
    </ul>
  );
}

const selectTitles = (plan: Plan) =>
  Object.fromEntries(plan.tasks.map((task) => [task.id, task.title]));
export function SavedProposalChanges({ item }: { item: InboxItem }) {
  const { data: liveTitles } = useQuery({
    ...planQuery,
    enabled: !item.taskTitles && item.changes.some((c) => taskField.test(c.field)),
    select: selectTitles,
  });
  return <ProposalChanges changes={item.changes} titles={{ ...liveTitles, ...item.taskTitles }} />;
}
