import * as Menu from "@radix-ui/react-dropdown-menu";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { Task } from "@2do/api/plan";
import type { TaskDetails, TaskSubtype, WriteTaskSubtype } from "@2do/api/task-plugins";
import { saveTaskSubtype, useTaskPlugins } from "./task-plugin-api.ts";
import { SubtypeCard, SubtypeRemoval, useTaskDetails, type Subtype } from "./task-subtypes.tsx";
import { TaskTypeIcon } from "./task-type-icon.tsx";
import { WorkflowActions } from "./workflow-actions.tsx";

function TypePicker({
  definitions,
  records,
  save,
  refresh,
}: {
  definitions: Subtype[];
  records: TaskSubtype[];
  save: (id: string, input: WriteTaskSubtype) => Promise<void>;
  refresh: () => void;
}) {
  const [removing, setRemoving] = useState<{ definition: Subtype; revision: string }>();
  const mutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: WriteTaskSubtype }) => save(id, input),
    onSuccess: () => setRemoving(undefined),
    onSettled: refresh,
  });
  const byType = new Map(records.map((record) => [record.typeId, record]));
  const available = definitions.filter((type) => !byType.get(type.id)?.data);
  return (
    <div className="property-row type-picker">
      <span className="property-label">Type</span>
      <div className="property-chips">
        {definitions.map((type) => {
          const record = byType.get(type.id);
          if (!record?.data) return null;
          return (
            <span
              key={type.id}
              className="property-chip"
              title={record.source === "automatic" ? "Inferred by Clef" : "User-confirmed"}
            >
              {type.label}
              <button
                type="button"
                aria-label={"Remove " + type.label}
                disabled={mutation.isPending}
                onClick={() => {
                  mutation.reset();
                  setRemoving({ definition: type, revision: record.revision });
                }}
              >
                <X size={13} aria-hidden="true" />
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
          <Menu.Root modal={false}>
            <Menu.Trigger
              className="property-add"
              aria-label="Add type"
              title="Add type"
              disabled={mutation.isPending}
            >
              <Plus size={15} aria-hidden="true" />
              {available.length === definitions.length && "Add type"}
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content
                className="property-menu"
                align="start"
                sideOffset={4}
                collisionPadding={8}
                aria-label="Available types"
              >
                {available.map((type) => (
                  <Menu.Item
                    key={type.id}
                    onSelect={() =>
                      mutation.mutate({
                        id: type.id,
                        input: {
                          revision: byType.get(type.id)?.revision ?? null,
                          data: type.initialData ?? {},
                        },
                      })
                    }
                  >
                    <TaskTypeIcon icon={type.icon} /> {type.label}
                  </Menu.Item>
                ))}
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
        {removing && (
          <SubtypeRemoval
            label={removing.definition.label}
            revision={removing.revision}
            busy={mutation.isPending}
            error={mutation.error?.message ?? ""}
            cancel={() => setRemoving(undefined)}
            remove={(revision) =>
              mutation.mutate({ id: removing.definition.id, input: { revision, data: null } })
            }
          />
        )}
        {!removing && mutation.isError && (
          <small className="error" role="alert">
            {mutation.error.message}
          </small>
        )}
      </div>
    </div>
  );
}

function WorkflowProperties({
  workflow,
}: {
  workflow: NonNullable<TaskDetails["workflows"]>[number];
}) {
  return (
    <dl className="workflow-properties">
      <div className="property-row">
        <dt>Status</dt>
        <dd role="status">{workflow.status}</dd>
      </div>
      {workflow.properties?.map((property) => (
        <div className="property-row" key={property.label}>
          <dt>{property.label}</dt>
          <dd className={property.value === null ? "property-empty" : undefined}>
            {property.value ?? "Not logged"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function InlineTaskProperties({
  task,
  active,
  inspect,
  renderPrompts,
}: {
  task: Task;
  active: boolean;
  inspect: () => void;
  renderPrompts?: (typeId: string) => ReactNode;
}) {
  const plugins = useTaskPlugins();
  const { details, error, refresh, accept } = useTaskDetails(task, active);
  const loadError = (plugins.error || error) && (
    <div className="actions">
      <small className="error" role="alert">
        {plugins.error || error}
      </small>
      <button
        type="button"
        onClick={() => {
          plugins.retry();
          void refresh();
        }}
      >
        Retry
      </button>
    </div>
  );
  if (!plugins.plugins || !details) return loadError || <small role="status">Loading types…</small>;
  const definitions = plugins.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.subtypes);
  if (!definitions.length)
    return (
      <div>
        No plugins enabled.{" "}
        <button type="button" onClick={inspect}>
          Open inspector
        </button>
      </div>
    );
  async function save(id: string, input: WriteTaskSubtype) {
    accept(await saveTaskSubtype(task.id, id, input));
  }
  const attached = details.subtypes.filter((record) => record.data);
  const logCount = details.workflows?.filter((workflow) =>
    workflow.actions.some((action) => action.id === "log"),
  ).length;
  return (
    <section className="property-sheet" aria-label="Task properties">
      {loadError}
      <TypePicker
        definitions={definitions}
        records={details.subtypes}
        save={save}
        refresh={refresh}
      />
      {definitions.map((definition) => {
        const record = details.subtypes.find((subtype) => subtype.typeId === definition.id);
        const workflow = details.workflows?.find((w) => w.typeId === definition.id);
        return (
          <div key={definition.id} className="property-group">
            {record?.data && attached.length > 1 && <h4>{definition.label}</h4>}
            <SubtypeCard
              definition={definition}
              subtype={record}
              layout="properties"
              refresh={refresh}
              write={(input) => save(definition.id, input)}
            >
              {renderPrompts?.(definition.id)}
              {workflow && (
                <>
                  <WorkflowProperties workflow={workflow} />
                  <WorkflowActions
                    taskId={task.id}
                    workflow={workflow}
                    compact
                    logShortcut={logCount === 1}
                  />
                </>
              )}
            </SubtypeCard>
          </div>
        );
      })}
    </section>
  );
}
