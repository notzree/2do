import { useMutation } from "@tanstack/react-query";
import { ArrowRight, Clock3 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TaskDetails } from "@2do/api/task-plugins";
import { imageMimeTypes } from "@2do/api/notebook";
import { api, queryClient } from "./query.ts";
import { uploadImage } from "./upload-image.ts";

type Workflow = NonNullable<TaskDetails["workflows"]>[number];
type Action = Workflow["actions"][number];
function focusFirstField(form: HTMLFormElement | null) {
  form?.querySelector<HTMLElement>("input, select, textarea")?.focus();
}
function openDraft(action: Action, workflow: Workflow) {
  return {
    commandId: crypto.randomUUID(),
    installationEpoch: workflow.installationEpoch,
    workflowRevision: workflow.workflowRevision,
    taskRevision: workflow.taskRevision,
    subtypeRevision: workflow.subtypeRevision,
    files: {} as Record<string, File | undefined>,
    values: Object.fromEntries(
      action.fields.map((field) => [field.key, String(action.defaults[field.key] ?? "")]),
    ),
  };
}

function ImageField({
  label,
  file,
  id,
  required,
  disabled,
  change,
}: {
  label: string;
  file?: File;
  id?: string;
  required?: boolean;
  disabled: boolean;
  change: (file?: File) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const preview = useRef<HTMLImageElement>(null);
  useEffect(() => {
    if (!file || !preview.current) return;
    const url = URL.createObjectURL(file);
    preview.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div className="workflow-image">
      <label>
        {label}
        <input
          type="file"
          ref={picker}
          accept={imageMimeTypes.join(",")}
          required={required && !file && !id}
          disabled={disabled}
          onChange={(e) => {
            const selected = e.currentTarget.files?.[0];
            if (selected) change(selected);
          }}
        />
      </label>
      {(file || id) && (
        <>
          <img
            ref={preview}
            src={file ? undefined : "/api/images/" + id}
            alt={label + " preview"}
          />
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (picker.current) picker.current.value = "";
              change();
            }}
          >
            Remove image
          </button>
        </>
      )}
    </div>
  );
}

function WorkflowInput({
  field,
  value,
  file,
  disabled,
  change,
}: {
  field: Action["fields"][number];
  value: string;
  file?: File;
  disabled: boolean;
  change: (value: string, file?: File) => void;
}) {
  if (field.kind === "image")
    return (
      <ImageField
        label={field.label}
        required={field.required}
        disabled={disabled}
        file={file}
        id={value}
        change={(file) => change("", file)}
      />
    );
  const props = { required: field.required, disabled, value };
  return (
    <label>
      {field.label}
      {field.kind === "choice" ? (
        <select {...props} onChange={(e) => change(e.currentTarget.value)}>
          <option value="">Choose…</option>
          {field.options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : field.kind === "text" ? (
        <textarea
          {...props}
          rows={3}
          maxLength={field.maxLength}
          onChange={(e) => change(e.currentTarget.value)}
        />
      ) : (
        <input
          {...props}
          type={field.kind}
          min={field.kind === "number" ? field.min : undefined}
          step={field.kind === "number" ? "any" : undefined}
          onChange={(e) => change(e.currentTarget.value)}
        />
      )}
    </label>
  );
}

async function submitWorkflowAction(
  taskId: string,
  typeId: string,
  action: Action,
  draft: ReturnType<typeof openDraft>,
) {
  const { values, files, ...revisions } = draft;
  const input: Record<string, number | string> = {};
  for (const field of action.fields) {
    const text = values[field.key]?.trim();
    const photo = files[field.key];
    if (field.kind === "image" && photo) input[field.key] = await uploadImage(photo);
    else if (text) input[field.key] = field.kind === "number" ? Number(text) : text;
  }
  return api.POST("/api/tasks/{id}/subtypes/{typeId}/actions/{actionId}", {
    params: { path: { id: taskId, typeId, actionId: action.id } },
    body: { ...revisions, input },
  });
}

function ActionTrigger({
  action,
  compact,
  logShortcut,
  begin,
}: {
  action: Action;
  compact: boolean;
  logShortcut: boolean;
  begin: () => void;
}) {
  return (
    <button
      type="button"
      onClick={begin}
      className={compact ? "property-action" : undefined}
      data-log-shortcut={logShortcut || undefined}
      aria-keyshortcuts={logShortcut ? "L" : undefined}
    >
      {compact &&
        (action.id === "log" ? (
          <Clock3 size={14} aria-hidden="true" />
        ) : (
          <ArrowRight size={14} aria-hidden="true" />
        ))}
      {action.label}
      {logShortcut && <kbd aria-hidden="true">l</kbd>}
    </button>
  );
}

function ActionForm({
  taskId,
  workflow,
  action,
  compact,
  logShortcut,
}: {
  taskId: string;
  workflow: Workflow;
  action: Action;
  compact: boolean;
  logShortcut: boolean;
}) {
  const [draft, setDraft] = useState<ReturnType<typeof openDraft>>();
  const stale =
    draft &&
    (draft.installationEpoch !== workflow.installationEpoch ||
      draft.workflowRevision !== workflow.workflowRevision ||
      draft.taskRevision !== workflow.taskRevision ||
      draft.subtypeRevision !== workflow.subtypeRevision);
  const mutation = useMutation({
    mutationFn: (base: ReturnType<typeof openDraft>) =>
      submitWorkflowAction(taskId, workflow.typeId, action, base),
    onSuccess: () => setDraft(undefined),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ["planner", "details", taskId] }),
        queryClient.invalidateQueries({ queryKey: ["planner", "summaries"] }),
        queryClient.invalidateQueries({ queryKey: ["planner", "reports"] }),
      ]),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    if (draft && !stale && !mutation.isPending) mutation.mutate(draft);
  }
  function begin() {
    const next = openDraft(action, workflow);
    setDraft(next);
    if (!action.fields.length) mutation.mutate(next);
  }
  if (!draft)
    return (
      <ActionTrigger action={action} compact={compact} logShortcut={logShortcut} begin={begin} />
    );
  function edit(key: string, value: string, file?: File) {
    setDraft(
      (current) =>
        current && {
          ...current,
          commandId: crypto.randomUUID(),
          values: { ...current.values, [key]: value },
          files: { ...current.files, [key]: file },
        },
    );
  }
  return (
    <form
      className="editor workflow-form"
      onSubmit={submit}
      aria-label={action.label}
      ref={compact ? focusFirstField : undefined}
    >
      {action.fields.map((field) => (
        <WorkflowInput
          key={field.key}
          field={field}
          value={draft.values[field.key] ?? ""}
          file={draft.files[field.key]}
          disabled={mutation.isPending || !!stale}
          change={(value, file) => edit(field.key, value, file)}
        />
      ))}
      {stale && <p role="status">This task changed. Reopen the action to use its latest values.</p>}
      {mutation.isError && (
        <p role="alert" className="error">
          {mutation.error.message}
        </p>
      )}
      <div className="actions">
        <button type="submit" disabled={mutation.isPending || stale}>
          {mutation.isPending ? "Saving…" : action.label}
        </button>
        <button
          type="button"
          disabled={mutation.isPending}
          onClick={() => {
            setDraft(undefined);
            mutation.reset();
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function WorkflowActions({
  taskId,
  workflow,
  compact = false,
  logShortcut = false,
}: {
  taskId: string;
  workflow: Workflow;
  compact?: boolean;
  logShortcut?: boolean;
}) {
  if (compact && !workflow.actions.length) return null;
  return (
    <div className={compact ? "property-actions" : "plugin-workflow"}>
      {!compact && <p role="status">{workflow.status}</p>}
      {workflow.actions.map((action) => (
        <ActionForm
          key={action.id}
          taskId={taskId}
          workflow={workflow}
          action={action}
          compact={compact}
          logShortcut={logShortcut && action.id === "log"}
        />
      ))}
    </div>
  );
}
