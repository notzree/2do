import { StrictMode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "@2do/api/plan";
import { createRoot } from "react-dom/client";
import {
  dayKey,
  formatDate,
  fullDate,
  monthDays,
  offsetDay,
  onDay,
  startOfWeek,
  weekDays,
  views,
  type View,
  type WeekStart,
} from "./calendar.ts";
import { DayEditor } from "./day-editor.tsx";
import { Sidebar } from "./sidebar.tsx";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { TaskList, type ListActions } from "./agenda.tsx";
import { Chatbar } from "./chatbar.tsx";
import { TaskDialog } from "./task-dialog.tsx";
import { usePlannerKeys } from "./vim.ts";
import { usePlan } from "./use-plan.ts";
import "./style.css";
import { Settings, sections, type Section } from "./settings.tsx";
import { readPreferences, storageKey, type Command, type Preferences } from "./preferences.ts";

function readLocation() {
  const segment = window.location.pathname.split("/")[2];
  const params = new URLSearchParams(window.location.search);
  const settings = segment === "settings";
  const view = views.find((v) => v === (settings ? params.get("from") : segment)) ?? "week";
  const section = settings
    ? (sections.find((s) => s.id === params.get("section"))?.id ?? "appearance")
    : null;
  const key = params.get("date") ?? "";
  const date = new Date(key + "T00:00:00");
  const selected = dayKey(date) === key ? date : new Date();
  return { view, date: selected, section };
}

function Wordmark() {
  return (
    <span className="landing-wordmark">
      2d<span className="landing-o">o</span>
    </span>
  );
}

function Landing() {
  return (
    <main className="landing">
      <div className="landing-scroll" aria-hidden="true" />
      <section className="landing-scene" aria-label="2do">
        <div className="landing-image-reveal" aria-hidden="true">
          <img src="/coast-sheep.jpg" alt="" fetchPriority="high" />
        </div>
        <a className="landing-brand" href="/" aria-label="2do home">
          <Wordmark />
        </a>
        <a className="landing-signin" href="/app">
          Sign in
        </a>
      </section>
    </main>
  );
}

function Month({
  date,
  tasks,
  weekStart,
  select,
}: {
  date: Date;
  tasks: Task[];
  weekStart: WeekStart;
  select: (day: Date) => void;
}) {
  return (
    <section className="month" aria-label="Choose a day">
      {weekDays(date, weekStart).map((d) => (
        <b key={d.getDay()}>{formatDate(d, { weekday: "short" })}</b>
      ))}
      {monthDays(date, weekStart).map((day) => {
        const count = tasks.filter((task) => onDay(task, day)).length;
        return (
          <button
            key={dayKey(day)}
            data-calendar-day={dayKey(day)}
            className={day.getMonth() !== date.getMonth() ? "outside" : ""}
            aria-current={dayKey(day) === dayKey(new Date()) ? "date" : undefined}
            aria-pressed={dayKey(day) === dayKey(date)}
            aria-label={fullDate(day) + ", " + count + " tasks"}
            onClick={() => select(day)}
          >
            {day.getDate()}
            {count > 0 && <small>{count}</small>}
          </button>
        );
      })}
    </section>
  );
}

function Notebook({
  view,
  date,
  firstDay,
  prefs,
  actions,
  error,
  go,
  shift,
}: {
  view: View;
  date: Date;
  firstDay: Date;
  prefs: Preferences;
  actions?: ListActions;
  error: string;
  go: (view: View, date: Date) => void;
  shift: (amount: number) => void;
}) {
  const title =
    view === "calendar"
      ? formatDate(date, { month: "long", year: "numeric" })
      : view === "week"
        ? "Weekly notebook"
        : "Daybook";
  const loose = actions?.plan.tasks.filter((t) => !t.schedule) ?? [];
  return (
    <main className="notebook-main" tabIndex={-1}>
      <div className="notebook-top">
        <span>
          <BookOpen size={15} /> Notebook <ChevronRight size={12} />{" "}
          {view === "calendar" ? "Calendar" : view === "week" ? "Week" : "Daybook"}
        </span>
        <div className="controls">
          <button aria-label="Previous period" onClick={() => shift(-1)}>
            <ChevronLeft size={16} />
          </button>
          <button onClick={() => go(view, new Date())}>Today</button>
          <button aria-label="Next period" onClick={() => shift(1)}>
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
      <div className="paper">
        <div className="page-heading">
          <p>{formatDate(firstDay, { month: "long", year: "numeric" })}</p>
          <h1>{title}</h1>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!actions && !error && <p role="status">Loading your plan…</p>}
        {actions && (
          <>
            {view === "calendar" && (
              <>
                <Month
                  weekStart={prefs.weekStart}
                  date={date}
                  tasks={actions.plan.tasks}
                  select={(d) => go(view, d)}
                />
                <div className="section-head calendar-heading">
                  <h2>{fullDate(date)}</h2>
                  <button onClick={() => go("day", date)}>Open day</button>
                </div>
              </>
            )}
            {Array.from({ length: view === "week" ? 7 : view === "day" ? 3 : 1 }, (_, i) =>
              offsetDay(firstDay, i),
            ).map((day) => (
              <DayEditor
                key={dayKey(day)}
                day={day}
                vim={prefs.keysEnabled}
                bindings={prefs.bindings}
                {...actions}
              />
            ))}
            {loose.length > 0 && (
              <details className="unscheduled">
                <summary>Unscheduled · {loose.length}</summary>
                <TaskList tasks={loose} {...actions} />
              </details>
            )}
          </>
        )}
      </div>
    </main>
  );
}

function PlannerView({
  prefs,
  change,
}: {
  prefs: Preferences;
  change: (patch: Partial<Preferences>) => void;
}) {
  const [{ view, date, section }, setLocation] = useState(readLocation);
  const { data, error, busy, mutate } = usePlan();
  const settingsOpen = section !== null;
  const [taskId, setTaskId] = useState<string | null>(null),
    [graph, setGraph] = useState(false);
  const firstDay = view === "week" ? startOfWeek(date, prefs.weekStart) : date;
  const origin = useRef<HTMLElement | null>(null);
  const dateKey = dayKey(date);

  useEffect(() => {
    const pop = () => {
      setLocation(readLocation());
      setTaskId(null);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  function go(nextView: View, nextDate: Date) {
    const link = "/app/" + nextView + "?date=" + dayKey(nextDate);
    if (location.pathname + location.search !== link) history.pushState(null, "", link);
    setLocation({ view: nextView, date: nextDate, section: null });
  }
  function settingsHref(nextSection: Section) {
    const params = new URLSearchParams({ from: view, date: dateKey });
    if (nextSection !== "appearance") params.set("section", nextSection);
    return "/app/settings?" + params;
  }
  function openSettings(nextSection: Section = "appearance") {
    const link = settingsHref(nextSection);
    if (location.pathname + location.search !== link) history.pushState(null, "", link);
    setLocation({ view, date, section: nextSection });
  }
  function runCommand(command: Command) {
    if (command === "settings") return openSettings();
    if (command === "today") return go(view, new Date());
    if (command === "copilot") {
      window.dispatchEvent(new Event("notebook-copilot"));
      return;
    }
    go(command, date);
    requestAnimationFrame(() => {
      const target =
        command === "calendar"
          ? document.querySelector<HTMLElement>('[data-calendar-day][aria-pressed="true"]')
          : document.querySelector<HTMLElement>("main");
      target?.focus();
    });
  }
  const editorCommand = useEffectEvent((e: Event) =>
    runCommand((e as CustomEvent<Command>).detail),
  );
  const showKeybinds = useEffectEvent(() => openSettings("keybinds"));
  useEffect(() => {
    window.addEventListener("notebook-go", editorCommand);
    window.addEventListener("notebook-help", showKeybinds);
    return () => {
      window.removeEventListener("notebook-go", editorCommand);
      window.removeEventListener("notebook-help", showKeybinds);
    };
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
  }, [settingsOpen]);
  function shift(by: number) {
    go(
      view,
      view === "calendar"
        ? new Date(date.getFullYear(), date.getMonth() + by, 1)
        : offsetDay(date, by * (view === "week" ? 7 : view === "day" ? 3 : 1)),
    );
  }
  function closeTask() {
    setTaskId(null);
    requestAnimationFrame(() => {
      const target =
        origin.current?.isConnected && origin.current.getClientRects().length
          ? origin.current
          : document.querySelector<HTMLElement>("main");
      target?.focus();
    });
  }
  usePlannerKeys({
    enabled: prefs.keysEnabled,
    bindings: prefs.bindings,
    command: runCommand,
    shift: (by) => {
      if (!section) shift(by);
    },
    help: () => openSettings("keybinds"),
    calendarDay: (key, by) => {
      const d = offsetDay(new Date(key + "T00:00:00"), by);
      go(view, d);
      requestAnimationFrame(() =>
        document.querySelector<HTMLButtonElement>(`[data-calendar-day="${dayKey(d)}"]`)?.focus(),
      );
    },
  });
  const actions = data && {
    plan: data,
    busy,
    mutate,
    open: (t: Task, show = false) => {
      origin.current = document.activeElement as HTMLElement;
      setTaskId(t.id);
      setGraph(show);
    },
  };
  const current = data?.tasks.find((t) => t.id === taskId);

  return (
    <>
      <Sidebar
        view={view}
        date={date}
        firstDay={firstDay}
        go={go}
        settings={settingsOpen}
        settingsHref={settingsHref("appearance")}
        openSettings={() => openSettings()}
        prefs={prefs}
      />
      {section ? (
        <Settings section={section} navigate={openSettings} prefs={prefs} change={change} />
      ) : (
        <Notebook
          view={view}
          date={date}
          firstDay={firstDay}
          prefs={prefs}
          actions={actions}
          error={current ? "" : error}
          go={go}
          shift={shift}
        />
      )}
      <Chatbar />
      {current && data && (
        <TaskDialog
          key={current.id}
          plan={data}
          task={current}
          graph={graph}
          showGraph={setGraph}
          select={setTaskId}
          close={closeTask}
          mutate={mutate}
          busy={busy}
          error={error}
          day={dateKey}
        />
      )}
    </>
  );
}
function applyAppearance({ theme, mode }: Preferences) {
  const root = document.documentElement;
  root.dataset.palette = theme;
  root.dataset.mode = mode;
  const color = getComputedStyle(root).backgroundColor;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", color);
}

const initialPreferences = readPreferences();
applyAppearance(initialPreferences);

function App() {
  const [prefs, setPrefs] = useState(initialPreferences);
  useLayoutEffect(() => {
    const update = () => applyAppearance(prefs);
    update();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [prefs]);
  useEffect(() => {
    const sync = (e: StorageEvent) => {
      if (e.key === storageKey || e.key === null) setPrefs(readPreferences());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function change(patch: Partial<Preferences>) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Use session state if storage is unavailable. */
    }
  }
  const path = window.location.pathname.replace(/\/$/, "");
  return ["/app", "/app/day", "/app/week", "/app/calendar", "/app/settings"].includes(path) ? (
    <PlannerView prefs={prefs} change={change} />
  ) : (
    <Landing />
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
