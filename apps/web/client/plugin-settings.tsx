import { useMutation } from "@tanstack/react-query";
import type { TaskPluginInstallation } from "@2do/api/task-plugins";
import { notebookCommands } from "./commands.ts";
import { setTaskPluginEnabled, useTaskPlugins } from "./task-plugin-api.ts";
import { TaskTypeIcon } from "./task-type-icon.tsx";

type Subtype = TaskPluginInstallation["subtypes"][number];

const confidence = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 3 });
const scopeLabel = { task: "this task", "local-day": "the same local day" };

function SubtypeCapabilities({ subtype, commands }: { subtype: Subtype; commands: string[] }) {
  const fields = subtype.editor?.flatMap((group) =>
    group.fields.map((field) => field.inlayLabel ?? field.label),
  );
  return (
    <section className="plugin-subtype">
      <h3>
        <TaskTypeIcon icon={subtype.icon} size={16} />
        {subtype.label}
      </h3>
      <dl className="plugin-capabilities">
        {commands.length > 0 && (
          <div>
            <dt>Capture command</dt>
            <dd>
              {commands.map(command => <code key={command}>/{command} </code>)}
            </dd>
          </div>
        )}
        {!!fields?.length && (
          <div>
            <dt>Fields</dt>
            <dd>{fields.join(", ")}</dd>
          </div>
        )}
        {!!subtype.prompts?.length && (
          <div>
            <dt>Prompts</dt>
            <dd>
              <ul>
                {subtype.prompts.map((prompt) => (
                  <li key={prompt.id}>
                    {prompt.label}
                    <small>
                      {prompt.trigger === "task.completed" ? "When completed" : "While open"}
                    </small>
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {!!subtype.actions?.length && (
          <div>
            <dt>Actions</dt>
            <dd>
              <ul>
                {subtype.actions.map((action) => (
                  <li key={action.id}>
                    {action.label}
                    {!!action.fields?.length && (
                      <small>{action.fields.map((f) => f.label).join(", ")}</small>
                    )}
                  </li>
                ))}
              </ul>
            </dd>
          </div>
        )}
        {subtype.classification && (
          <div>
            <dt>Auto-classification</dt>
            <dd>
              <details className="plugin-classifier">
                <summary>
                  Highest score above {confidence.format(subtype.classification.threshold)} wins
                </summary>
                <p>{subtype.classification.instructions}</p>
              </details>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function PluginSetting({
  plugin,
  catalog,
  update,
  openGoals,
}: {
  plugin: TaskPluginInstallation;
  catalog: TaskPluginInstallation[];
  openGoals?: () => void;
  update: (value: TaskPluginInstallation) => void;
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setTaskPluginEnabled(plugin.id, enabled),
    onSuccess: update,
  });
  // Preview the exact shortcut that will be available if this plugin is enabled.
  const commands = notebookCommands(
    plugin.enabled
      ? catalog
      : catalog.map((p) => (p.id === plugin.id ? { ...p, enabled: true } : p)),
  );
  const { metrics, facts, features } = plugin;

  return (
    <article className="plugin-setting" aria-labelledby={"plugin-name-" + plugin.id}>
      <div className="plugin-setting-head">
        <div>
          <h2 id={"plugin-name-" + plugin.id}>{plugin.label}</h2>
          {plugin.description && <p>{plugin.description}</p>}
        </div>
        <label className="toggle plugin-toggle">
          <small>{plugin.enabled ? "Enabled" : "Disabled"}</small>
          <input
            type="checkbox"
            aria-label={"Enable " + plugin.label}
            checked={plugin.enabled}
            disabled={toggle.isPending}
            onChange={(e) => toggle.mutate(e.currentTarget.checked)}
          />
          <span aria-hidden="true" />
        </label>
      </div>
      {toggle.error && (
        <p className="error" role="alert">
          {toggle.error.message}
        </p>
      )}
      {plugin.subtypes.map((subtype) => (
        <SubtypeCapabilities
          key={subtype.id}
          subtype={subtype}
          commands={commands.flatMap(c=>c.kind==="typed" && c.typeId===subtype.id ? [c.name] : [])}
        />
      ))}
      {!!plugin.goalSubtypes?.length && <section className="plugin-metrics"><h3>Goal types</h3>
        <ul>{plugin.goalSubtypes.map(type=><li key={type.id}>{type.label}</li>)}</ul>
        {plugin.enabled && openGoals && <button onClick={openGoals}>Manage goals</button>}
      </section>}
      {!!metrics?.length && (
        <section className="plugin-metrics">
          <h3>Metrics</h3>
          <p>Daily, weekly and monthly totals</p>
          <ul>
            {metrics.map((metric) => (
              <li key={metric.id}>
                {metric.label} <small>{metric.unit}</small>
              </li>
            ))}
          </ul>
          {plugin.enabled && openGoals && (
            <button type="button" className="plugin-goals" onClick={openGoals}>
              Manage daily goals
            </button>
          )}
        </section>
      )}
      {(!!facts?.length || !!features?.length) && (
        <details className="plugin-integrations">
          <summary>Plugin integrations</summary>
          <dl className="plugin-capabilities">
            {!!facts?.length && (
              <div>
                <dt>Declared facts</dt>
                <dd>
                  <ul>
                    {facts.map((fact) => (
                      <li key={fact.id}>
                        <code>{fact.id}</code>
                        <small>
                          v{fact.version} ·{" "}
                          {fact.scopes.map((scope) => scopeLabel[scope]).join(", ")}
                        </small>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
            {!!features?.length && (
              <div>
                <dt>Connections</dt>
                <dd>
                  <ul>
                    {features.map((feature) => (
                      <li key={feature.id}>
                        {feature.label}
                        <small>
                          Requires access to <code>{feature.requires.id}</code> v
                          {feature.requires.version} for {scopeLabel[feature.scope]}
                        </small>
                      </li>
                    ))}
                  </ul>
                </dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </article>
  );
}

export function PluginSettings({ openGoals }: { openGoals?: () => void }) {
  const { plugins, error, retry, update } = useTaskPlugins();
  return (
    <>
      <p className="plugin-intro">
        Enable plugins for this account. Disabling a plugin keeps its saved data.
      </p>
      {error && (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button type="button" onClick={retry}>
            Retry
          </button>
        </div>
      )}
      {!plugins && !error && <p role="status">Loading plugins…</p>}
      {plugins?.length === 0 && <p>No plugins are available.</p>}
      {plugins?.map((plugin) => (
        <PluginSetting
          key={plugin.id}
          plugin={plugin}
          catalog={plugins}
          update={update}
          openGoals={openGoals}
        />
      ))}
    </>
  );
}
