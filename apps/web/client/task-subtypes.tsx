import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "./query.ts";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { Task } from "@2do/api/plan";
import type {
  TaskDetails,
  EligibleTaskPrompt,
  TaskPluginInstallation,
  TaskSubtype,
  WriteTaskSubtype,
} from "@2do/api/task-plugins";
import { Modal } from "./modal.tsx";
import { WorkflowActions } from "./workflow-actions.tsx";
import { Check, RefreshCw, Sparkles } from "lucide-react";
import { TaskTypeIcon } from "./task-type-icon.tsx";
import { readTaskDetails, saveTaskSubtype, useTaskPlugins } from "./task-plugin-api.ts";
import { fieldName, readFields, writeFields, type FieldValues } from "./subtype-fields.ts";

type Subtype = TaskPluginInstallation["subtypes"][number];
type Write = (input: WriteTaskSubtype) => Promise<void>;

function useTaskDetails(task: Task, active: boolean) {
  const queryKey = ["planner", "details", task.id];
  const query = useQuery({
    queryKey,
    enabled: active,
    queryFn: ({ signal }) => readTaskDetails(task.id, signal),
    refetchInterval: (q) => (q.state.data?.classification === "pending" || q.state.data?.workflows?.some(w=>w.pending) ? 1500 : false),
  });
  return {
    details: query.data,
    error: query.error?.message,
    refresh: query.refetch,
    accept: (subtype: TaskSubtype) =>
      queryClient.setQueryData<TaskDetails>(
        queryKey,
        (current) =>
          current && {
            ...current,
            subtypes: [...current.subtypes.filter((s) => s.typeId !== subtype.typeId), subtype],
          },
      ),
  };
}

function SubtypeEditor({
  editor,
  label,
  values,
  saved,
  disabled,
  busy,
  onChange,
  onSubmit,
}: {
  editor: NonNullable<Subtype["editor"]>;
  label: string;
  values: FieldValues;
  saved: boolean;
  disabled: boolean;
  busy: boolean;
  onChange: (name: string, value: string) => void;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <form className="editor" onSubmit={onSubmit}>
      {editor.map((group) => {
        const inputs = group.fields.map((field) => {
          const name = fieldName(group, field);
          const value = values[name] ?? "";
          return (
            <label key={name}>
              {field.label}
              {field.kind === "text-list" ? (
                <>
                  <textarea
                    rows={2}
                    disabled={busy}
                    value={value}
                    onChange={(event) => onChange(name, event.currentTarget.value)}
                  />
                  <small>One item per line</small>
                </>
              ) : (
                <input
                  disabled={busy}
                  type="number"
                  min={field.min}
                  step="any"
                  value={value}
                  onChange={(event) => onChange(name, event.currentTarget.value)}
                />
              )}
            </label>
          );
        });
        return group.key ? (
          <fieldset className="subtype-fieldset" key={group.key}>
            {group.label && <legend>{group.label}</legend>}
            <div className="field-pair">{inputs}</div>
          </fieldset>
        ) : (
          <div className="editor" key="main">
            {inputs}
          </div>
        );
      })}
      <div className="actions">
        <button type="submit" disabled={disabled}>
          Save {label}
        </button>
        {saved && <small role="status">Saved</small>}
      </div>
    </form>
  );
}

function SubtypeRemoval({
  label,
  revision,
  busy,
  error,
  cancel,
  remove,
}: {
  label: string;
  revision?: string;
  busy: boolean;
  error: string;
  cancel: () => void;
  remove: (revision: string) => void;
}) {
  if (!revision) return null;
  return (
    <Modal title={"Remove " + label + "?"} close={cancel} alert>
      <p>This removes the saved {label} details from this task.</p>
      <button type="button" className="danger" disabled={busy} onClick={() => remove(revision)}>
        Remove {label}
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

function SubtypeCard({
  definition,
  subtype,
  write,
  refresh,
  inline = false,
  children,
}: {
  definition: Subtype;
  subtype: TaskSubtype | undefined;
  write: Write;
  refresh: () => void;
  inline?: boolean;
  children?: ReactNode;
}) {
  const [draft, setDraft] = useState<{ base: TaskSubtype; values: FieldValues }>();
  const [validationError, setValidationError] = useState("");
  const [removeRevision, setRemoveRevision] = useState<string>();
  const { editor = [], label } = definition;
  const data = subtype?.data;
  const values = draft?.values ?? (data ? readFields(editor, data) : {});
  const changed = !!draft && draft.base.revision !== subtype?.revision;
  const editable =
    (draft?.base ?? subtype)?.schemaVersion === definition.schemaVersion && editor.length > 0;

  const mutation = useMutation({
    mutationFn: write,
    onMutate: () => setValidationError(""),
    onSuccess: () => {
      setDraft(undefined);
      setRemoveRevision(undefined);
    },
    onSettled: () => {
      refresh();
    },
  });
  const busy = mutation.isPending;
  const error = validationError || mutation.error?.message || "";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!draft?.base.data || changed || busy) return;
    try {
      const updated = writeFields(editor, draft.base.data, draft.values);
      mutation.mutate({ revision: draft.base.revision, data: updated });
    } catch (cause) {
      setValidationError(cause instanceof Error ? cause.message : "Check the subtype fields.");
    }
  }

  if (!data && !draft && inline) return <small>This detail is no longer available.</small>;
  if (!data && !draft)
    return (
      <div className="type-add">
        <span>{subtype?.source === "manual" ? label + " · Removed by you" : "Add type"}</span>
        <button
          type="button"
          disabled={busy}
          aria-label={(subtype?.source === "manual" ? "Restore " : "Add ") + label}
          onClick={() =>
            mutation.mutate({
              revision: subtype?.revision ?? null,
              data: definition.initialData ?? {},
            })
          }
        >
          {subtype?.source === "manual" ? "Restore " : "+ "}
          {label}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    );

  const storedFields = data ? readFields(editor, data) : {};
  const fieldEditor = (
    <SubtypeEditor
      editor={editor}
      label={label}
      values={values}
      saved={mutation.isSuccess && !draft && !!data}
      disabled={!draft || busy || changed}
      busy={busy}
      onSubmit={submit}
      onChange={(name, value) => {
        if (!subtype) return;
        setDraft((current) => ({
          base: current?.base ?? subtype,
          values: { ...(current?.values ?? values), [name]: value },
        }));
      }}
    />
  );

  return (
    <section className="subtype-card" aria-label={label}>
      {!inline && (
        <div className="section-head">
          <h4>
            <TaskTypeIcon icon={definition.icon} />
            {label}
          </h4>
          <button
            type="button"
            className="plain"
            disabled={busy || changed}
            aria-label={"Remove " + label}
            onClick={() => setRemoveRevision(subtype?.revision)}
          >
            Remove
          </button>
        </div>
      )}
      {!inline && subtype && (
        <small className="type-source">
          {subtype.source === "automatic" ? (
            <>
              <Sparkles size={11} aria-hidden="true" /> Inferred by Clef
            </>
          ) : (
            <>
              <Check size={11} aria-hidden="true" /> User-confirmed
            </>
          )}
        </small>
      )}
      {!inline && editable && data && (
        <dl className="type-values">
          {editor.flatMap((g) =>
            g.fields.flatMap((f) => {
              const value = storedFields[fieldName(g, f)];
              return value
                ? [
                    <div key={fieldName(g, f)}>
                      <dt>{f.label}</dt>
                      <dd>{value.replaceAll("\n", ", ")}</dd>
                    </div>,
                  ]
                : [];
            }),
          )}
        </dl>
      )}
      {!editable && !inline && (
        <small>Saved with field schema version {subtype?.schemaVersion}.</small>
      )}
      {editable &&
        (inline ? (
          fieldEditor
        ) : (
          <details className="type-edit">
            <summary>Edit {label} details</summary>
            {fieldEditor}
          </details>
        ))}
      {children}
      {changed && (
        <div className="actions">
          <p className="error" role="alert">
            {label} changed while you were editing.
          </p>
          <button
            type="button"
            onClick={() => {
              setDraft(undefined);
              setValidationError("");
              mutation.reset();
            }}
          >
            Use latest details
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <SubtypeRemoval
        label={label}
        revision={removeRevision}
        busy={busy}
        error={error}
        cancel={() => setRemoveRevision(undefined)}
        remove={(revision) => mutation.mutate({ revision, data: null })}
      />
    </section>
  );
}

export function PromptFields({ task, prompt }: { task: Task; prompt: EligibleTaskPrompt }) {
  const plugins = useTaskPlugins();
  const { details, error, refresh, accept } = useTaskDetails(task, true);
  const definition = plugins.plugins
    ?.filter((p) => p.enabled)
    .flatMap((p) => p.subtypes)
    .find((t) => t.id === prompt.typeId);
  if (error || plugins.error) return <small role="alert">{error || plugins.error}</small>;
  if (!details || !plugins.plugins) return <small role="status">Loading detail…</small>;
  if (!definition) return <small>This detail is no longer available.</small>;
  const editor = (definition.editor ?? []).flatMap((group) => {
    const fields = group.fields.filter((f) => fieldName(group, f) === prompt.field);
    return fields.length
      ? [{ ...group, fields: group.requiredTogether ? group.fields : fields }]
      : [];
  });
  return (
    <SubtypeCard
      inline
      definition={{ ...definition, editor }}
      subtype={details.subtypes.find((s) => s.typeId === definition.id)}
      refresh={refresh}
      write={async (input) => {
        accept(await saveTaskSubtype(task.id, definition.id, input));
      }}
    />
  );
}

export function TaskSubtypes({
  task,
  active,
  openPlugins,
  renderPrompts,
  compact = false,
}: {
  task: Task;
  active: boolean;
  openPlugins: () => void;
  renderPrompts?: (typeId: string) => ReactNode;
  compact?: boolean;
}) {
  const { plugins, error: pluginError, retry } = useTaskPlugins();
  const { details, error, refresh, accept } = useTaskDetails(task, active);
  const [showAvailable, setShowAvailable] = useState(false);
  const seenTypes = useRef(new Set<string>());
  useEffect(() => {
    for (const subtype of details?.subtypes ?? []) {
      if (subtype.data !== null) seenTypes.current.add(subtype.typeId);
    }
  }, [details]);
  const definitions = plugins?.filter(({ enabled }) => enabled).flatMap(({ subtypes }) => subtypes);
  const classify = useMutation({
    mutationFn: () => api.POST("/api/tasks/{id}/classify", { params: { path: { id: task.id } } }),
    onSuccess: () =>
      Promise.all([
        refresh(),
        queryClient.invalidateQueries({ queryKey: ["planner", "summaries"] }),
      ]),
  });
  const canClassify =
    details &&
    definitions?.some(
      (t) => !details.subtypes.some((s) => s.typeId === t.id && (s.source === "manual" || s.schemaVersion !== t.schemaVersion)),
    );
  const receipt = details?.lastClassification;
  const matchedLabels = receipt?.matched.map(
    (id) => definitions?.find((d) => d.id === id)?.label ?? id,
  );
  const card = (definition: Subtype) => (
    <SubtypeCard
      key={task.id + definition.id}
      definition={definition}
      subtype={details?.subtypes.find(({ typeId }) => typeId === definition.id)}
      refresh={refresh}
      write={async (input) => {
        accept(await saveTaskSubtype(task.id, definition.id, input));
      }}
    >
      {renderPrompts?.(definition.id)}
      {details?.workflows
        ?.filter((workflow) => workflow.typeId === definition.id)
        .map((workflow) => (
          <WorkflowActions key={workflow.typeId} taskId={task.id} workflow={workflow} />
        ))}
    </SubtypeCard>
  );
  if (compact) {
    const attached =
      definitions?.filter((definition) =>
        details?.subtypes.some((s) => s.typeId === definition.id && s.data !== null),
      ) ?? [];
    const available = definitions?.filter((definition) => !attached.includes(definition)) ?? [];
    return (
      <section className="task-subtypes task-subtypes-compact" aria-label="Types and fields">
        <h3>Types and fields</h3>
        {(pluginError || error) && (
          <div className="actions">
            <p className="error" role="alert">
              {pluginError || error}
            </p>
            <button
              type="button"
              onClick={() => {
                if (pluginError) retry();
                if (error) refresh();
              }}
            >
              Retry
            </button>
          </div>
        )}
        {(!plugins || !details) && !pluginError && !error && <p role="status">Loading types…</p>}
        {details && available.length > 0 && (
          <button
            type="button"
            className="type-add-toggle"
            aria-expanded={showAvailable}
            onClick={() => setShowAvailable(!showAvailable)}
          >
            {showAvailable ? "Hide available types" : "+ Add type"}
          </button>
        )}
        {details &&
          definitions?.map((definition) => (
            <div
              key={definition.id}
              hidden={
                !showAvailable &&
                !attached.includes(definition) &&
                !seenTypes.current.has(definition.id)
              }
            >
              {card(definition)}
            </div>
          ))}
        {details && definitions?.length === 0 && (
          <p>
            No plugins enabled.{" "}
            <button type="button" onClick={openPlugins}>
              Open inspector
            </button>
          </p>
        )}
      </section>
    );
  }
  return (
    <section className="task-subtypes" aria-label="Task subtypes">
      <div className="section-head">
        <h3>Plugin types</h3>
        {!definitions?.length && plugins && (
          <button type="button" onClick={openPlugins}>
            Enable plugins
          </button>
        )}
      </div>
      {(pluginError || error) && (
        <div className="actions">
          <p className="error" role="alert">
            {pluginError || error}
          </p>
          <button
            type="button"
            onClick={() => {
              if (pluginError) retry();
              if (error) refresh();
            }}
          >
            Retry
          </button>
        </div>
      )}
      {(!plugins || !details) && !pluginError && !error && <p role="status">Loading types…</p>}
      {details?.classification === "pending" && (
        <p className="type-note" role="status">
          Clef is checking enabled types…
        </p>
      )}
      {details?.classification === "failed" && (
        <p className="type-note" role="status">
          Clef couldn’t finish classifying this task.
        </p>
      )}
      {details && definitions?.length === 0 && (
        <p className="type-note">No plugins enabled for this planner.</p>
      )}
      {details && definitions?.map(card)}
      {receipt && (
        <div className="type-activity">
          <h3>Activity</h3>
          <p>
            <Check size={12} aria-hidden="true" />
            <span>
              Clef checked{" "}
              {matchedLabels?.length ? "· " + matchedLabels.join(", ") : "· No matching types"}
            </span>
          </p>
          <time dateTime={receipt.checkedAt}>
            {new Date(receipt.checkedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </div>
      )}
      {canClassify && details.classification !== "pending" && (
        <div className="type-refresh">
          <button type="button" disabled={classify.isPending} onClick={() => classify.mutate()}>
            <RefreshCw size={12} aria-hidden="true" />
            {classify.isPending
              ? "Queueing…"
              : details.classification === "failed"
                ? "Retry classification"
                : receipt || details.subtypes.some((s) => s.source === "automatic")
                  ? "Recheck types"
                  : "Classify task"}
          </button>
        </div>
      )}
      {classify.isError && (
        <p className="error" role="alert">
          {classify.error.message}
        </p>
      )}
    </section>
  );
}
