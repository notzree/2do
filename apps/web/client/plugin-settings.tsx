import { useMutation } from "@tanstack/react-query";
import type { TaskPluginInstallation } from "@2do/api/task-plugins";
import { setTaskPluginEnabled, useTaskPlugins } from "./task-plugin-api.ts";

function PluginSetting({
  plugin,
  update,
}: {
  plugin: TaskPluginInstallation;
  update: (value: TaskPluginInstallation) => void;
}) {
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setTaskPluginEnabled(plugin.id, enabled),
    onSuccess: update,
  });

  return (
    <section className="setting-row">
      <div>
        <h2>{plugin.label}</h2>
        <p>{plugin.subtypes.map(({ label }) => label).join(", ")}</p>
        {toggle.error && (
          <p className="error" role="alert">
            {toggle.error.message}
          </p>
        )}
      </div>
      <label className="toggle">
        <input
          type="checkbox"
          aria-label={"Enable " + plugin.label}
          checked={plugin.enabled}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.currentTarget.checked)}
        />
        <span aria-hidden="true" />
      </label>
    </section>
  );
}

export function PluginSettings() {
  const { plugins, error, retry, update } = useTaskPlugins();
  return (
    <>
      <p className="preferences-note">
        Enabled plugins classify new tasks and title changes automatically using Workers AI. Plugin
        settings apply to your account.
      </p>
      {error && (
        <div>
          <p className="error" role="alert">
            {error}
          </p>
          <button onClick={retry}>Retry</button>
        </div>
      )}
      {!plugins && !error && <p role="status">Loading plugins…</p>}
      {plugins?.map((plugin) => (
        <PluginSetting key={plugin.id} plugin={plugin} update={update} />
      ))}
    </>
  );
}
