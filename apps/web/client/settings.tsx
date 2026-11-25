import {
  Check,
  Monitor,
  Moon,
  RotateCcw,
  Settings2,
  Sun,
} from "lucide-react";
import {
  availableKeys,
  boundCommand,
  commands,
  defaultBindings,
  themes,
  type Preferences,
} from "./preferences.ts";
import { shortcuts } from "./vim.ts";
import { PluginSettings } from "./plugin-settings.tsx";
import { sections, type Section } from "./settings-sections.ts";
import "./settings.css";

const modes = [
  { id: "system", label: "System", Icon: Monitor },
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
] as const;

type Props = {
  prefs: Preferences;
  change: (patch: Partial<Preferences>) => void;
  section: Section;
  navigate: (section: Section) => void;
};

export function Settings({ prefs, change, section, navigate }: Props) {
  return (
    <main className="notebook-main settings-main" tabIndex={-1}>
      <div className="notebook-top">
        <span>
          <Settings2 size={15} /> Workspace settings
        </span>
      </div>
      <div className="settings-paper">
        <h1>Settings</h1>
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(({ id, title, Icon }) => (
            <button
              key={id}
              aria-current={section === id ? "page" : undefined}
              onClick={() => navigate(id)}
            >
              <Icon size={16} />
              {title}
            </button>
          ))}
        </nav>
        {section === "appearance" && (
          <>
            <section className="setting-row">
              <div>
                <h2>Color mode</h2>
                <p>Use a light or dark palette, or follow your device.</p>
              </div>
              <div className="segments" role="group" aria-label="Color mode">
                {modes.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    aria-pressed={prefs.mode === id}
                    onClick={() => change({ mode: id })}
                  >
                    <Icon size={15} />
                    {label}
                  </button>
                ))}
              </div>
            </section>
            <section className="theme-library">
              <h2>Color theme</h2>
              <p>Choose a palette for your notebook and workspace.</p>
              <div className="theme-grid" role="group" aria-label="Color theme">
                {themes.map((theme) => (
                  <button
                    className="theme-card"
                    key={theme.id}
                    aria-label={theme.name}
                    aria-pressed={prefs.theme === theme.id}
                    onClick={() => change({ theme: theme.id })}
                  >
                    <span className="theme-cover" data-palette={theme.id} aria-hidden="true">
                      <span className="cover-type">Aa</span>
                      <span className="cover-pattern" />
                    </span>
                    <span className="theme-caption">
                      <span>
                        <strong>{theme.name}</strong>
                        <small>
                          <span className="light-variant">{theme.light}</span>
                          <span className="dark-variant">{theme.dark}</span>
                        </small>
                      </span>
                      <span className="choice-dot" aria-hidden="true">
                        {prefs.theme === theme.id && <Check size={12} strokeWidth={3} />}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          </>
        )}
        {section === "keybinds" && (
          <>
            <section className="setting-row">
              <div>
                <h2>Vim shortcuts</h2>
                <p>Use normal mode in the editor and keyboard navigation in the planner.</p>
              </div>
              <label className="toggle">
                <input
                  type="checkbox"
                  aria-label="Enable Vim shortcuts"
                  checked={prefs.keysEnabled}
                  onChange={(e) => change({ keysEnabled: e.target.checked })}
                />
                <span aria-hidden="true" />
              </label>
            </section>
            <section className="bindings-section">
              <div className="section-head">
                <h2>Navigation shortcuts</h2>
                <button
                  className="reset-keys"
                  disabled={commands.every((c) => prefs.bindings[c.id] === c.key)}
                  onClick={() => change({ bindings: defaultBindings })}
                >
                  <RotateCcw size={13} /> Reset bindings
                </button>
              </div>
              <p>
                Press <kbd>g</kbd>, then the assigned key.
              </p>
              {commands.map(({ id, name }) => (
                <label key={id} className="binding-row">
                  {name}
                  <span>
                    <kbd>g</kbd>
                    <select
                      aria-label={name + " shortcut"}
                      value={prefs.bindings[id]}
                      onChange={(e) =>
                        change({ bindings: { ...prefs.bindings, [id]: e.target.value } })
                      }
                    >
                      {availableKeys.map((k) => (
                        <option
                          key={k}
                          disabled={!!boundCommand(prefs.bindings, k) && prefs.bindings[id] !== k}
                        >
                          {k}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              ))}
            </section>
            <details className="shortcut-reference">
              <summary>Editor and planner key reference</summary>
              <dl className="shortcuts">
                {shortcuts.map(([key, label]) => (
                  <div key={label}>
                    <dt>
                      <kbd>{key}</kbd>
                    </dt>
                    <dd>{label}</dd>
                  </div>
                ))}
              </dl>
            </details>
          </>
        )}
        {section === "calendar" && (
          <section className="setting-row">
            <div>
              <h2>First day of the week</h2>
              <p>Set the first column of the calendar and the first page of the weekly notebook.</p>
            </div>
            <div className="segments" role="group" aria-label="First day of the week">
              {(["Sunday", "Monday"] as const).map((day, i) => (
                <button
                  key={day}
                  aria-pressed={prefs.weekStart === i}
                  onClick={() => change({ weekStart: i === 0 ? 0 : 1 })}
                >
                  {day}
                </button>
              ))}
            </div>
          </section>
        )}
        {section === "plugins" ? <PluginSettings /> : (
          <footer className="preferences-note">
            <Monitor size={13} /> Preferences apply on this device.
          </footer>
        )}
      </div>
    </main>
  );
}
