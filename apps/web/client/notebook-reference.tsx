import { createContext, useContext, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { GripVertical } from "lucide-react";
import type { Task } from "@2do/api/plan";
import type { DayBuffer } from "./day-buffer.ts";
import type { ListActions } from "./agenda.tsx";
import { DependencyGraph } from "./graph.tsx";
import { timeRange } from "./calendar.ts";
import { TaskHints } from "./task-hints.tsx";

export const NotebookReferences = createContext<{ actions: ListActions; buffer: DayBuffer } | null>(
  null,
);

function GraphEmbed({ task, actions }: { task: Task; actions: ListActions }) {
  const [focus, setFocus] = useState(task.id);
  return (
    <DependencyGraph
      plan={actions.plan}
      task={actions.plan.tasks.find((t) => t.id === focus) ?? task}
      select={setFocus}
      inline
    />
  );
}
export function NotebookReference({ node, selected }: NodeViewProps) {
  const context = useContext(NotebookReferences);
  if (!context) throw new Error("Missing notebook reference context");
  const { actions, buffer } = context;
  const id: string = node.attrs.id;
  const task = actions.plan.tasks.find((item) => item.id === id);
  return (
    <NodeViewWrapper
      contentEditable={false}
      className={`embedded ${node.type.name}`}
      data-ref={node.type.name}
      data-id={id}
      data-selected={actions.selectedId === id || undefined}
      data-node-selected={selected || undefined}
    >
      <span className="embed-grip" data-drag-handle title="Drag to reorder">
        <GripVertical size={14} />
      </span>
      {node.type.name === "graphRef" && task ? (
        <GraphEmbed task={task} actions={actions} />
      ) : (
        <>
          <input
            type="checkbox"
            disabled={!task || actions.busy}
            checked={task?.completed ?? false}
            aria-label={
              task
                ? `Mark ${task.title} ${task.completed ? "incomplete" : "complete"}`
                : "Toggle task completion"
            }
            onChange={() =>
              task &&
              void actions.mutate.updateTask(task.id, {
                revision: task.revision,
                completed: !task.completed,
              })
            }
          />
          <div className="embed-copy">
            {task ? (
              <TaskHints
                task={task}
                inspect={() => actions.open(task)}
                meta={timeRange(task)}
                title={
                  <button
                    data-task={task.id}
                    className={"embed-title" + (task?.completed ? " done" : "")}
                    onClick={() => actions.open(task)}
                  >
                    {task.title}
                  </button>
                }
              />
            ) : (
              <span className="pending-title">{buffer.taskTitle(id) ?? "Unavailable task"}</span>
            )}
          </div>
        </>
      )}
    </NodeViewWrapper>
  );
}
