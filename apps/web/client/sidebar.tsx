import { useState, type MouseEvent } from "react";
import {
  BookOpen,
  CalendarDays,
  Columns3,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  NotebookPen,
  ChevronRight,
} from "lucide-react";
import { dayKey, formatDate, offsetDay, type View } from "./calendar.ts";
import type { Preferences } from "./preferences.ts";

const nav = [
  { view: "day", title: "Daybook", Icon: BookOpen },
  { view: "week", title: "Week", Icon: Columns3 },
  { view: "calendar", title: "Calendar", Icon: CalendarDays },
] as const;

type Props = {
  view: View;
  date: Date;
  firstDay: Date;
  go: (view: View, date: Date) => void;
  settings: boolean;
  settingsHref: string;
  openSettings: () => void;
  prefs: Preferences;
};
export function Sidebar({
  view,
  date,
  firstDay,
  go,
  settings,
  settingsHref,
  openSettings,
  prefs,
}: Props) {
  const [open, setOpen] = useState(false);
  const count = view === "day" ? 3 : view === "week" ? 7 : 1;
  function navigate(event: MouseEvent<HTMLAnchorElement>, action: () => void) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    action();
    setOpen(false);
  }
  return (
    <>
      <div className="mobile-bar">
        <button aria-label="Toggle sidebar" aria-expanded={open} onClick={() => setOpen(!open)}>
          <PanelLeftOpen size={19} />
        </button>
        <strong>2do.</strong>
      </div>
      {open && (
        <button
          className="side-backdrop"
          aria-label="Close sidebar"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        className={"notebook-side" + (open ? " mobile-open" : "")}
        aria-label="Notebook sidebar"
      >
        <div className="brand-row">
          <a className="notebook-brand" href="/app/day">
            <span>
              <NotebookPen size={21} strokeWidth={1.7} />
            </span>
            2do<span className="brand-stop">.</span>
          </a>
          <button
            className="mobile-close"
            aria-label="Close sidebar"
            onClick={() => setOpen(false)}
          >
            <PanelLeftClose size={17} />
          </button>
        </div>
        <nav aria-label="Planner views">
          {nav.map(({ view: v, title, Icon }) => (
            <a
              key={v}
              href={`/app/${v}?date=${dayKey(date)}`}
              aria-current={!settings && view === v ? "page" : undefined}
              onClick={(e) => navigate(e, () => go(v, date))}
            >
              <Icon size={17} />
              {title}
              {prefs.keysEnabled && <kbd>g {prefs.bindings[v]}</kbd>}
            </a>
          ))}
        </nav>
        {!settings && (
          <div className="contents">
            <h2>On this page</h2>
            {Array.from({ length: count }, (_, i) => offsetDay(firstDay, i)).map((d) => (
              <button
                key={dayKey(d)}
                onClick={() => {
                  const el = document.getElementById("day-" + dayKey(d));
                  el?.scrollIntoView({ block: "start" });
                  el?.querySelector<HTMLElement>(".ProseMirror")?.focus({ preventScroll: true });
                  setOpen(false);
                }}
              >
                <span className="index-dot" />
                {formatDate(d, { weekday: "short", month: "short", day: "numeric" })}
                <ChevronRight size={12} />
              </button>
            ))}
          </div>
        )}
        <div className="side-bottom">
          <a
            className="settings-link"
            href={settingsHref}
            aria-current={settings ? "page" : undefined}
            onClick={(e) => navigate(e, openSettings)}
          >
            <Settings size={16} />
            Settings{prefs.keysEnabled && <kbd>g {prefs.bindings.settings}</kbd>}
          </a>
        </div>
      </aside>
    </>
  );
}
