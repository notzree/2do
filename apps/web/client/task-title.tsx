import { useRef, useState, type ButtonHTMLAttributes } from "react";
import { flushSync } from "react-dom";
import type { Task } from "@2do/api/plan";
import { focusTaskTitle } from "./notebook-focus.ts";
import type { TitleCaret } from "./commands.ts";
import type { Mutate } from "./use-plan.ts";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  task: Task;
  update: Mutate["updateTask"];
};

export function TaskTitle({ task, update, onClick, children, ...props }: Props) {
  const button = useRef<HTMLButtonElement | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const saving = useRef(false);
  const [draft, setDraft] = useState<{ original: string } | null>(null);
  const [error, setError] = useState("");

  function begin(position: TitleCaret) {
    flushSync(() => setDraft({ original: task.title }));
    const field = input.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    const caret = position === "end" ? field.value.length : 0;
    field.setSelectionRange(caret, caret);
  }

  function finish(restoreFocus: boolean) {
    flushSync(() => {
      setDraft(null);
      setError("");
    });
    if (restoreFocus && button.current) focusTaskTitle(button.current);
  }

  async function save(restoreFocus: boolean) {
    const field = input.current;
    if (!draft || !field || saving.current) return;
    const title = field.value.trim();
    if (!title) {
      setError("Enter a task title.");
      return;
    }
    if (title !== draft.original && title !== task.title) {
      if (task.title !== draft.original) {
        setError("The title changed elsewhere. Press Escape to load the current title.");
        return;
      }
      saving.current = true;
      field.readOnly = true;
      const saved = await update(task.id, { title, revision: task.revision });
      saving.current = false;
      field.readOnly = false;
      if (!saved) {
        setError("Couldn’t save the title. Press Enter to retry or Escape to cancel.");
        return;
      }
    }
    finish(restoreFocus && document.activeElement === field);
  }

  if (!draft)
    return (
      <button
        {...props}
        type="button"
        data-task={task.id}
        ref={(node) => {
          button.current = node;
          if (!node) return;
          const edit = (e: Event) => begin((e as CustomEvent<TitleCaret>).detail);
          node.addEventListener("edit-task-title", edit);
          return () => node.removeEventListener("edit-task-title", edit);
        }}
        onClick={onClick ?? (() => begin("end"))}
      >
        {children ?? task.title}
      </button>
    );

  return (
    <span className="task-title-editor">
      <input
        ref={input}
        data-inline-title
        aria-label="Task title"
        aria-invalid={!!error}
        defaultValue={draft.original}
        maxLength={240}
        onChange={() => {
          if (error) setError("");
        }}
        onBlur={() => void save(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          if (saving.current) return;
          if (event.key === "Escape") finish(true);
          else void save(true);
        }}
      />
      {error && <small role="alert">{error}</small>}
    </span>
  );
}
