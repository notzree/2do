import { createContext, useContext, useRef, useState, type ReactNode } from "react";
import { ChevronDown, Ellipsis, Sparkles, X } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import type { Task } from "@2do/api/plan";
import type { TaskSummary } from "@2do/api/task-summaries";
import { summariesKey, type useWeekTaskHints } from "./task-summary-api.ts";
import { api, queryClient } from "./query.ts";
import { PromptFields, TaskSubtypes } from "./task-subtypes.tsx";
import { TaskTypeIcon } from "./task-type-icon.tsx";
import "./task-hints.css";

const Summaries = createContext<ReadonlyMap<string, TaskSummary>>(new Map());

export function WeekTaskHints({ hints, children }: {
  hints: ReturnType<typeof useWeekTaskHints>;
  children: ReactNode;
}) {
  const { summaries, failed } = hints;
  return (
    <Summaries.Provider value={summaries}>
      {children}
      {failed.length > 0 && (
        <div className="hint-status" role="status">
          Task hints unavailable.{" "}
          <button
            type="button"
            onClick={() => {
              for (const q of failed) void q.refetch();
            }}
          >
            Retry
          </button>
        </div>
      )}
    </Summaries.Provider>
  );
}

function PromptPreference({
  taskId,
  prompt,
  skipped,
}: {
  taskId: string;
  prompt: TaskSummary["prompts"][number];
  skipped: boolean;
}) {
  const mutation = useMutation({
    mutationFn: () =>
      api.PUT("/api/tasks/{id}/prompts/{promptId}", {
        params: { path: { id: taskId, promptId: prompt.id } },
        body: { skipped },
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: summariesKey }),
  });
  return (
    <>
      <button
        type="button"
        className="plain"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
        aria-label={(skipped ? "Skip " : "Restore ") + prompt.label}
      >
        {skipped ? "Skip" : "Restore"}
      </button>
      {mutation.isError && <small role="alert">{mutation.error.message}</small>}
    </>
  );
}

export function InspectorPrompt({
  task,
  prompt,
}: {
  task: Task;
  prompt: TaskSummary["prompts"][number];
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div>
      <div className="hint-actions">
        <span>{prompt.label}</span>
        <button
          type="button"
          aria-expanded={editing}
          aria-label={(editing ? "Close detail: " : "Add detail: ") + prompt.label}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "Close" : "Add detail"}
        </button>
        {!editing && <PromptPreference taskId={task.id} prompt={prompt} skipped />}
      </div>
      {editing && <PromptFields task={task} prompt={prompt} />}
    </div>
  );
}

export function SkippedHints({
  taskId,
  prompts,
}: {
  taskId: string;
  prompts: TaskSummary["prompts"];
}) {
  const skipped = prompts.filter((p) => p.skipped);
  if (!skipped.length) return null;
  return (
    <details>
      <summary>Skipped hints ({skipped.length})</summary>
      {skipped.map((prompt) => (
        <div className="hint-actions" key={prompt.id}>
          {prompt.label}
          <PromptPreference taskId={taskId} prompt={prompt} skipped={false} />
        </div>
      ))}
    </details>
  );
}

export function TaskHints({
  task,
  inspect,
  title,
  meta,
}: {
  task: Task;
  inspect: () => void;
  title: ReactNode;
  meta?: string;
}) {
  const summary = useContext(Summaries).get(task.id);
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState(false);
  const [editing, setEditing] = useState<TaskSummary["prompts"][number]>();
  const toggle = useRef<HTMLButtonElement>(null);
  const types = summary?.types ?? [];
  // A changed batch key briefly has no data. Keep the open field's draft mounted during the read.
  const active =
    editing && (!summary || types.some((t) => t.typeId === editing.typeId)) ? editing : undefined;
  const prompts = summary?.prompts.filter((p) => !p.skipped) ?? [];
  const inlays = summary?.inlays ?? [];
  const visiblePrompts =
    active && !prompts.some((p) => p.id === active.id) ? [...prompts, active] : prompts;
  return (
    <div className="task-hints">
      <div className="hint-heading">
        {title}
        <div className="hint-tags">
          {task.kind !== "task" && (
            <button type="button" className="hint-chip" onClick={inspect} title="Task kind">
              <TaskTypeIcon icon={task.kind === "event" ? "calendar" : "tag"} />
              {task.kind === "event" ? "Event" : "Milestone"}
            </button>
          )}
          {types.map((t) => (
            <button
              type="button"
              key={t.typeId}
              className="hint-chip"
              onClick={inspect}
              aria-label={`Inspect ${t.label} · ${t.source === "automatic" ? "Inferred" : "User-selected"}`}
              title={t.source === "automatic" ? "Inferred type" : "User-selected type"}
            >
              <TaskTypeIcon icon={t.icon} />
              {t.label}
            </button>
          ))}
          {summary?.classification === "pending" && (
            <span className="hint-pending" role="status" title="Clef is classifying this task">
              <span aria-hidden="true" />
              Classifying
            </span>
          )}
          <button
            type="button"
            className="hint-inspect"
            aria-label={"Inspect " + task.title}
            title="Task inspector"
            onClick={inspect}
          >
            <Ellipsis size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="hint-context">
        <button
          ref={toggle}
          type="button"
          className="hint-toggle"
          data-task-enrich
          aria-expanded={expanded}
          onClick={() => {
            setOpened(true);
            setExpanded(!expanded);
          }}
        >
          <Sparkles size={12} aria-hidden="true" />
          {!prompts.length
            ? "Details"
            : prompts.length + (prompts.length === 1 ? " optional detail" : " optional details")}
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {meta && <span>{meta}</span>}
        {!!task.carriedFrom?.length && <span className="muted" title={`Carried from ${task.carriedFrom.join(", ")}`}>
          {task.createdDate ? "Created " + task.createdDate : "Carried from " + task.carriedFrom[0]} · carried {task.carriedFrom.length}×
        </span>}
        {inlays.map((v) => (
          <span
            key={v.typeId + "." + v.field}
            className="hint-value"
            title={v.label + " · " + v.value}
          >
            {v.label} · {v.value}
          </span>
        ))}
        {summary?.classification === "failed" && (
          <button type="button" className="hint-failed" onClick={inspect}>
            Classification failed
          </button>
        )}
      </div>
      {(opened || active) && (
        <div className="hint-body" hidden={!expanded}>
          <div className="hint-caption">
            <span>Optional details</span>
            <button
              type="button"
              className="plain"
              aria-label="Collapse optional details"
              onClick={() => {
                setExpanded(false);
                toggle.current?.focus();
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          </div>
          {visiblePrompts.map((prompt) => (
            <div key={prompt.id}>
              <div className="hint-actions">
                <span>{prompt.label}</span>
                <button
                  type="button"
                  aria-expanded={active?.id === prompt.id}
                  aria-label={
                    (active?.id === prompt.id ? "Close detail: " : "Add detail: ") + prompt.label
                  }
                  onClick={() => setEditing(active?.id === prompt.id ? undefined : prompt)}
                >
                  {active?.id === prompt.id ? "Close" : "Add detail"}
                </button>
                {active?.id !== prompt.id && (
                  <PromptPreference taskId={task.id} prompt={prompt} skipped />
                )}
              </div>
              {active?.id === prompt.id && <PromptFields task={task} prompt={active} />}
            </div>
          ))}
          <TaskSubtypes task={task} active={expanded} openPlugins={inspect} compact />
        </div>
      )}
    </div>
  );
}
