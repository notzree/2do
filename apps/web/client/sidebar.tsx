import { useState, type MouseEvent } from "react";
import {
  CalendarDays,
  Columns3,
  Settings,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  Inbox,
} from "lucide-react";
import { dayKey, formatDate, type View } from "./calendar.ts";
import type { Preferences } from "./preferences.ts";
import { NotebookBrand } from "./notebook-brand.tsx";

const nav = [
  { view: "week", title: "Week", Icon: Columns3 },
  { view: "calendar", title: "Month", Icon: CalendarDays },
] as const;

type Props = {
  view: View;
  date: Date;
  days: Date[];
  go: (view: View, date: Date, focused?: boolean) => void;
  settings: boolean;
  settingsHref: string;
  openSettings: () => void;
  prefs: Preferences;
  reviewOpen: boolean;
  pendingReview: number;
  review: () => void;
};
export function Sidebar({
  view,
  date,
  days,
  go,
  settings,
  settingsHref,
  openSettings,
  prefs,
  reviewOpen, pendingReview, review,
}: Props) {
  const [open, setOpen] = useState(false);
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
        <NotebookBrand />
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
          <a className="brand-link" href={`/app/week?date=${dayKey(date)}`}
            onClick={(event) => navigate(event, () => go("week", date))}>
            <NotebookBrand />
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
          <button type="button" className="review-link" aria-pressed={reviewOpen}
            onClick={() => { setOpen(false); review(); }}>
            <Inbox size={17} /> Review {pendingReview > 0 && <span aria-label={pendingReview + " pending"}>{pendingReview}</span>}
          </button>
        </nav>
        {!settings && (
          <div className="contents">
            <h2>{view === "calendar" ? "Selected day" : "On this page"}</h2>
            {days.map((d) => (
              <button
                key={dayKey(d)}
                aria-current={dayKey(d) === dayKey(date) ? "date" : undefined}
                onClick={() => {
                  if (view === "calendar") {
                    go("week", d, true);
                    setOpen(false);
                    return;
                  }
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
