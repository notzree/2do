import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { TaskDetails } from "@2do/api/task-plugins";
import { imageMimeTypes } from "@2do/api/notebook";
import { api, queryClient } from "./query.ts";
import { uploadImage } from "./upload-image.ts";

type Workflow = NonNullable<TaskDetails["workflows"]>[number];
type Action = Workflow["actions"][number];
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

function ActionForm({
  taskId,
  workflow,
  action,
}: {
  taskId: string;
  workflow: Workflow;
  action: Action;
}) {
  const [draft, setDraft] = useState<ReturnType<typeof openDraft>>();
  const stale =
    draft &&
    (draft.installationEpoch !== workflow.installationEpoch ||
      draft.workflowRevision !== workflow.workflowRevision ||
      draft.taskRevision !== workflow.taskRevision ||
      draft.subtypeRevision !== workflow.subtypeRevision);
  const mutation = useMutation({
    mutationFn: async (base: ReturnType<typeof openDraft>) => {
      const { values, files, ...revisions } = base;
      const input: Record<string, number | string> = {};
      for (const field of action.fields) {
        const text = values[field.key]?.trim();
        const photo = files[field.key];
        if (field.kind === "image" && photo) input[field.key] = await uploadImage(photo);
        else if (text) input[field.key] = field.kind === "number" ? Number(text) : text;
      }
      return api.POST("/api/tasks/{id}/subtypes/{typeId}/actions/{actionId}", {
        params: { path: { id: taskId, typeId: workflow.typeId, actionId: action.id } },
        body: { ...revisions, input },
      });
    },
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
      <button type="button" onClick={begin}>
        {action.label}
      </button>
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
    <form className="editor workflow-form" onSubmit={submit} aria-label={action.label}>
      {action.fields.map((field) =>
        field.kind === "image" ? (
          <ImageField
            key={field.key}
            label={field.label}
            required={field.required}
            disabled={!!(mutation.isPending || stale)}
            file={draft.files[field.key]}
            id={draft.values[field.key]}
            change={(file) => edit(field.key, "", file)}
          />
        ) : (
          <label key={field.key}>
            {field.label}
            {field.kind === "text" ? (
              <textarea
                rows={3}
                maxLength={field.maxLength}
                required={field.required}
                disabled={mutation.isPending || stale}
                value={draft.values[field.key] ?? ""}
                onChange={(e) => edit(field.key, e.currentTarget.value)}
              />
            ) : (
              <input
                type={field.kind}
                min={field.kind === "number" ? field.min : undefined}
                step={field.kind === "number" ? "any" : undefined}
                required={field.required}
                disabled={mutation.isPending || stale}
                value={draft.values[field.key] ?? ""}
                onChange={(e) => edit(field.key, e.currentTarget.value)}
              />
            )}
          </label>
        ),
      )}
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

export function WorkflowActions({ taskId, workflow }: { taskId: string; workflow: Workflow }) {
  return (
    <div className="plugin-workflow">
      <p role="status">{workflow.status}</p>
      {workflow.actions.map((action) => (
        <ActionForm key={action.id} taskId={taskId} workflow={workflow} action={action} />
      ))}
    </div>
  );
}
