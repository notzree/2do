import { createContext, useContext, useId, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Ellipsis } from "lucide-react";
import { useMutation } from "@tanstack/react-query";
import type { Task } from "@2do/api/plan";
import type { TaskSummary } from "@2do/api/task-summaries";
import { summariesKey, type useWeekTaskHints } from "./task-summary-api.ts";
import { api, queryClient } from "./query.ts";
import { PromptFields } from "./task-subtypes.tsx";
import { InlineTaskProperties } from "./inline-task-properties.tsx";
import { TaskTypeIcon } from "./task-type-icon.tsx";
import "./task-hints.css";

const Summaries = createContext<ReadonlyMap<string, TaskSummary>>(new Map());

export function WeekTaskHints({
  hints,
  children,
}: {
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
  const [panel, setPanel] = useState<"initial" | "open" | "closed">("initial");
  const expanded = panel === "open";
  const body = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  const types = summary?.types ?? [];
  const prompts = summary?.prompts.filter((p) => !p.skipped) ?? [];
  const inlays = summary?.inlays ?? [];
  const context =
    [
      ...inlays.map((inlay) =>
        inlays.length > 1 || Number.isFinite(Number(inlay.value))
          ? inlay.label + " · " + inlay.value
          : inlay.value,
      ),
      ...new Set(types.flatMap((type) => (type.status ? [type.status] : []))),
      meta,
      task.carriedFrom?.length &&
        (task.createdDate ? "Created " + task.createdDate : "Carried from " + task.carriedFrom[0]) +
          " · carried " +
          task.carriedFrom.length +
          "×",
      prompts.length > 0 &&
        (prompts.length === 1 ? "1 optional detail" : prompts.length + " optional details"),
    ]
      .filter(Boolean)
      .join(" · ") || "Details";
  return (
    <div className="task-hints" data-expanded={expanded || undefined}>
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
          type="button"
          className="hint-toggle"
          data-task-enrich
          aria-expanded={expanded}
          aria-controls={panel !== "initial" ? bodyId : undefined}
          aria-label={`${expanded ? "Collapse" : "Expand"} details for ${task.title}. ${context}`}
          onKeyDown={(event) => {
            if (!expanded || event.key !== "l" || event.altKey || event.ctrlKey || event.metaKey)
              return;
            const log = body.current?.querySelector<HTMLButtonElement>("[data-log-shortcut]");
            if (log) {
              event.preventDefault();
              event.stopPropagation();
              log.click();
            }
          }}
          onClick={() => setPanel(expanded ? "closed" : "open")}
        >
          <ChevronRight size={13} aria-hidden="true" />
          <span>{context}</span>
        </button>
        {summary?.classification === "failed" && (
          <button type="button" className="hint-failed" onClick={inspect}>
            Classification failed
          </button>
        )}
      </div>
      {panel !== "initial" && (
        <div className="hint-body" id={bodyId} ref={body} hidden={!expanded}>
          <InlineTaskProperties
            task={task}
            active={expanded}
            inspect={inspect}
            renderPrompts={(typeId) =>
              prompts
                .filter((prompt) => prompt.typeId === typeId)
                .map((prompt) => (
                  <div className="hint-actions" key={prompt.id}>
                    <span>{prompt.label}</span>
                    <button
                      type="button"
                      aria-label={"Add detail: " + prompt.label}
                      onClick={() => {
                        const label = body.current?.querySelector<HTMLLabelElement>(
                          `[data-subtype="${CSS.escape(typeId)}"] [data-field="${CSS.escape(prompt.field)}"]`,
                        );
                        label?.control?.focus();
                      }}
                    >
                      Add detail
                    </button>
                    <PromptPreference taskId={task.id} prompt={prompt} skipped />
                  </div>
                ))
            }
          />
        </div>
      )}
    </div>
  );
}
