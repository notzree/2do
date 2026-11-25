import { NotebookNavigation } from "./commands.ts";
import { selectChat, useChats } from "./chats.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./query.ts";
import { StrictMode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Task } from "@2do/api/plan";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  dayKey,
  formatDate,
  offsetDay,
  weekDays,
  onDay,
  weekOfMonth,
  nextDate,
  previousDate,
  views,
  type View,
} from "./calendar.ts";
import { MonthCalendar } from "./month-calendar.tsx";
import { DayEditor } from "./day-editor.tsx";
import { Sidebar } from "./sidebar.tsx";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Search,
  PanelRight,
  Keyboard,
  Sparkles,
} from "lucide-react";
import { TaskList, type ListActions } from "./agenda.tsx";
import { WorkspaceCommands, type CommandScope } from "./workspace-commands.tsx";
import { ReviewPanel, useReviewInbox } from "./review-inbox.tsx";
import { Chatbar } from "./chatbar.tsx";
import { TaskInspector } from "./task-dialog.tsx";
import { WeekTaskHints } from "./task-hints.tsx";
import { usePlannerKeys } from "./vim.ts";
import { usePlan } from "./use-plan.ts";
import "./style.css";
import { Settings } from "./settings.tsx";
import { sections, type Section } from "./settings-sections.ts";
import { useReportSettings } from "./plugin-report-api.ts";
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
  const focused = view === "week" && params.get("focus") === "1";
  return { view, date: selected, section, focused };
}

function Landing() {
  const scene = useRef<HTMLElement>(null);
  const oStart = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const sceneNode = scene.current!;
    const marker = oStart.current!;
    const wordmark = marker.parentElement!;

    window.scrollTo(0, 0);
    function alignReveal() {
      // The marker starts at the o and spans its x-height above the baseline.
      // Layout offsets stay in the wordmark's initial, unscaled coordinates.
      const oWidth = wordmark.offsetWidth - marker.offsetLeft;
      const centerX = marker.offsetLeft + oWidth / 2 - wordmark.offsetWidth / 2;
      const centerY = marker.offsetTop + marker.offsetHeight / 2 - wordmark.offsetHeight / 2;
      sceneNode.style.setProperty("--landing-mask-start-x", `calc(50vw + ${centerX}px)`);
      sceneNode.style.setProperty("--landing-mask-start-y", `calc(50svh + ${centerY}px)`);
      // Extend the photo under the stroke so the glyph defines the visible edge.
      sceneNode.style.setProperty("--landing-mask-start-rx", `${oWidth * 0.36}px`);
      sceneNode.style.setProperty("--landing-mask-start-ry", `${marker.offsetHeight * 0.49}px`);
    }

    alignReveal();
    const observer = new ResizeObserver(alignReveal);
    observer.observe(wordmark);
    observer.observe(marker);
    return () => observer.disconnect();
  }, []);

  return (
    <main className="landing">
      <div className="landing-scroll" aria-hidden="true" />
      <section className="landing-scene" aria-label="twodo" ref={scene}>
        <div className="landing-image-reveal" aria-hidden="true">
          <img src="/coast-sheep.jpg" alt="" fetchPriority="high" />
        </div>
        <a className="landing-brand" href="/" aria-label="twodo home">
          <span className="landing-wordmark">
            twod<span className="landing-o-start" ref={oStart} aria-hidden="true" />o
          </span>
        </a>
        <a className="landing-signin" href="/app">
          Sign in
        </a>
      </section>
    </main>
  );
}

type Go = (view: View, date: Date, focused?: boolean) => void;

function LocalClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    const update = () => {
      const next = new Date();
      setNow(next);
      timer = window.setTimeout(update, 60_000 - next.getTime() % 60_000);
    };
    update();
    return () => window.clearTimeout(timer);
  }, []);
  return <time className="status-clock" dateTime={now.toISOString()} title="Current local time">
    {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
  </time>;
}

const weekRange = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric" });

function plannerHref(view: View, date: Date, focused: boolean) {
  return "/app/" + view + "?date=" + dayKey(date) + (focused ? "&focus=1" : "");
}

function NotebookHeader({ view, focused, today, shift, commands, inspect, inspectorOpen }: {
  view: View;
  focused: boolean;
  today: () => void;
  shift: (amount: number) => void;
  commands: () => void;
  inspect: () => void;
  inspectorOpen: boolean;
}) {
  const unit = view === "calendar" ? "month" : focused ? "day" : "week";
  return (
    <header className="notebook-top">
      <span className="notebook-crumb"><BookOpen size={14} /> Notebook <ChevronRight size={12} />
        {view === "calendar" ? "Month" : focused ? "Focused week" : "Week"}</span>
      <div className="controls">
        <button type="button" className="commands-trigger" aria-label="Commands" title="Commands" onClick={commands}>
          <Search size={14} /><span>Commands</span><kbd>{/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K"}</kbd>
        </button>
        <span className="tool-divider" />
        <button aria-label={`Previous ${unit}`} onClick={() => shift(-1)}><ChevronLeft size={15} /></button>
        <button onClick={today}>Today</button>
        <button aria-label={`Next ${unit}`} onClick={() => shift(1)}><ChevronRight size={15} /></button>
        <button type="button" onClick={inspect} aria-label={inspectorOpen ? "Close task inspector" : "Choose a task to inspect"}
          title="Task inspector" aria-pressed={inspectorOpen}><PanelRight size={15}/></button>
      </div>
    </header>
  );
}

function WeekHeading({ days, focused, tasks, selectedDate, weekStart }: {
  days: Date[]; focused: boolean; tasks?: Task[]; selectedDate: Date; weekStart: Preferences["weekStart"];
}) {
  const start = days[0], end = days[days.length - 1];
  const scheduled = tasks?.filter((t) => days.some((d) => onDay(t, d)));
  const open = scheduled?.filter((t) => !t.completed).length ?? 0;
  const range = focused ? formatDate(start, { weekday: "long", month: "short", day: "numeric" })
    : weekRange.formatRange(start, end);
  return (
    <div className="week-heading">
      <p className="week-dateline">{focused ? "Focused week" :
        "Week " + weekOfMonth(selectedDate, weekStart) + " of " + formatDate(selectedDate, { month: "long" })} <span> / </span>
        {selectedDate.getFullYear()}</p>
      <h1>{range}</h1>
      {scheduled && <p className="week-meta">Notebook <i>·</i> {open} open {open === 1 ? "task" : "tasks"} <i>·</i> {scheduled.length - open} done</p>}
    </div>
  );
}

function Notebook({
  view, date, days, focused, prefs, actions, error, go, shift, focusTarget, finishFocus, selectDay, commands, inspect, inspectorOpen, onHintStatus, openSettings,
}: {
  view: View;
  date: Date;
  days: Date[];
  focused: boolean;
  prefs: Preferences;
  actions?: ListActions;
  error: string;
  go: Go;
  shift: (amount: number) => void;
  focusTarget: string | null;
  finishFocus: () => void;
  selectDay: (day: Date) => void;
  commands: () => void;
  inspect: () => void;
  inspectorOpen: boolean;
  onHintStatus: (status: string) => void;
  openSettings: (section: Section) => void;
}) {
  const loose = actions?.plan.tasks.filter((t) => !t.schedule) ?? [];
  const [showLoose, setShowLoose] = useState(false);
  return (
    <main className="notebook-main" tabIndex={-1}>
      <NotebookHeader view={view} focused={focused} shift={shift} commands={commands} inspect={inspect} inspectorOpen={inspectorOpen} today={() => go(view, new Date(), focused)} />
      <div className={view === "calendar" ? "month-page" : "paper"}>
        {view === "week" && <WeekHeading days={days} selectedDate={date} weekStart={prefs.weekStart} focused={focused} tasks={actions?.plan.tasks} />}
        {error && <p className="error" role="alert">{error}</p>}
        {!actions && !error && <p role="status">Loading your plan…</p>}
        {actions && (view === "calendar" ? (
          <MonthCalendar date={date} weekStart={prefs.weekStart} tasks={actions.plan.tasks}
            update={actions.mutate.updateTask} open={actions.open} select={(d) => go(view, d)}
            openWeek={() => go("week", date)} openSettings={openSettings} />
        ) : (
          <WeekTaskHints onStatus={onHintStatus} days={days} tasks={actions.plan.tasks} includeUnscheduled={!focused && showLoose}>
            {days.map((day) => (
              <DayEditor
                key={dayKey(day)}
                day={day}
                focused={focused}
                shiftPeriod={shift}
                toggleFocus={() => go("week", day, !focused)}
                onSelect={() => selectDay(day)}
                onFocusRequested={focusTarget === dayKey(day) ? finishFocus : undefined}
                vim={prefs.keysEnabled}
                bindings={prefs.bindings}
                {...actions}
              />
            ))}
            {!focused && loose.length > 0 && (
              <details className="unscheduled" open={showLoose} onToggle={(e) => setShowLoose(e.currentTarget.open)}>
                <summary>Unscheduled · {loose.length}</summary>
                <TaskList tasks={loose} {...actions} />
              </details>
            )}
          </WeekTaskHints>
        ))}
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
  const [{ view, date, section, focused }, setLocation] = useState(readLocation);
  useReportSettings();
  const { data, error, busy, mutate } = usePlan();
  const settingsOpen = section !== null;
  const review = useReviewInbox();
  const closeReview = review.close;
  const reviewOrigin = useRef<HTMLElement | null>(null);
  const [palette, setPalette] = useState<CommandScope | null>(null);
  const [editorMode, setEditorMode] = useState("Normal");
  const [hintStatus, setHintStatus] = useState("Ready");
  const captureTarget = useRef<string | null>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
          !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (document.querySelector("dialog[open]:not(.workspace-commands)")) return;
      event.preventDefault();
      setPalette((current) => current ? null : "commands");
    };
    const modeChanged = (event: Event) => setEditorMode((event as CustomEvent<string>).detail);
    const focusChanged = (event: FocusEvent) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.matches("[data-inline-title]")) setEditorMode("Insert");
      else setEditorMode(event.target.closest<HTMLElement>(".writing-surface")?.dataset.mode ?? "Normal");
    };
    window.addEventListener("keydown", shortcut);
    window.addEventListener("notebook-mode", modeChanged);
    window.addEventListener("focusin", focusChanged);
    return () => {
      window.removeEventListener("keydown", shortcut);
      window.removeEventListener("notebook-mode", modeChanged);
      window.removeEventListener("focusin", focusChanged);
    };
  }, []);
  const [taskId, setTaskId] = useState<string | null>(null),
    [graph, setGraph] = useState(false);
  const chatOpen = useChats((state) => state.open);
  const days = view === "week" && !focused ? weekDays(date, prefs.weekStart) : [date];
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const dateKey = dayKey(date);

  useEffect(() => {
    if (chatOpen) {
      setTaskId(null);
      closeReview();
    }
  }, [chatOpen, closeReview]);

  useEffect(() => {
    const pop = () => {
      setFocusTarget(null);
      setLocation(readLocation());
      closeReview();
      setTaskId(null);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [closeReview]);
  useEffect(() => {
    if (window.location.pathname.replace(/\/$/, "") === "/app/day")
      history.replaceState(null, "", plannerHref("week", date, false));
  }, [date]);
  function go(nextView: View, nextDate: Date, nextFocused = false, focusGrid = false) {
    setTaskId(null);
    review.close();
    const link = plannerHref(nextView, nextDate, nextFocused);
    if (location.pathname + location.search !== link) history.pushState(null, "", link);
    setFocusTarget(nextView === "week" || focusGrid ? dayKey(nextDate) : null);
    setLocation({ view: nextView, date: nextDate, section: null, focused: nextFocused });
  }
  function selectDay(day: Date) {
    if (view !== "week" || dayKey(day) === dateKey) return;
    setFocusTarget(null);
    history.replaceState(null, "", plannerHref(view, day, focused));
    setLocation({ view, date: day, section: null, focused });
  }
  function settingsHref(nextSection: Section) {
    const params = new URLSearchParams({ from: view, date: dateKey });
    if (focused) params.set("focus", "1");
    if (nextSection !== "appearance") params.set("section", nextSection);
    return "/app/settings?" + params;
  }
  function openSettings(nextSection: Section = "appearance") {
    setTaskId(null);
    review.close();
    const link = settingsHref(nextSection);
    if (location.pathname + location.search !== link) history.pushState(null, "", link);
    setFocusTarget(null);
    setLocation({ view, date, section: nextSection, focused });
  }
  function runCommand(command: Command) {
    if (command === "settings") return openSettings();
    if (command === "today") return go(view, new Date(), focused);
    if (command === "nextDay" || command === "nextWeek" || command === "nextMonth") {
      const target = nextDate(date, command);
      go(view, target, focused, true);
      return;
    }
    if (
      command === "previousDay" ||
      command === "previousWeek" ||
      command === "previousMonth"
    ) {
      const target = previousDate(date, command);
      go(view, target, focused, true);
      return;
    }
    if (command === "copilot") {
      review.close();
      selectChat(useChats.getState().selected);
      return;
    }
    go(command, date, false, true);
  }
  useEffect(() => {
    window.scrollTo(0, 0);
    document.querySelector<HTMLElement>("main")?.focus({ preventScroll: true });
  }, [settingsOpen]);
  useEffect(() => {
    if (section || view !== "calendar" || !focusTarget || !data) return;
    const cell = document.querySelector<HTMLElement>(`[data-calendar-day="${focusTarget}"]`);
    cell?.focus();
    setFocusTarget(null);
  }, [section, view, focusTarget, data]);
  function shift(by: number) {
    go(
      view,
      view === "calendar"
        ? new Date(date.getFullYear(), date.getMonth() + by, 1)
        : offsetDay(date, by * (focused ? 1 : 7)),
      focused,
    );
  }
  function closeTask() {
    flushSync(() => setTaskId(null));
    const daySurface = view === "week"
      ? document.getElementById("day-" + dateKey)?.querySelector<HTMLElement>(".ProseMirror")
      : document.querySelector<HTMLElement>(`[data-calendar-day="${dateKey}"]`);
    const target =
      origin.current?.isConnected && origin.current.getClientRects().length
        ? origin.current
        : daySurface ?? document.querySelector<HTMLElement>("main");
    if (target?.matches(".ProseMirror")) target.dispatchEvent(new Event("notebook-refocus"));
    else target?.focus({ preventScroll: true });
  }
  function closeReviewer() {
    review.close();
    requestAnimationFrame(() => {
      const origin = reviewOrigin.current;
      const target = origin?.isConnected && origin.getClientRects().length ? origin : document.querySelector<HTMLElement>("main");
      target?.focus({ preventScroll: true });
    });
  }
  function showReviewer() {
    if (review.open) return closeReviewer();
    const active = document.activeElement;
    reviewOrigin.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setTaskId(null);
    if (useChats.getState().open) useChats.setState({ open: false });
    review.show();
  }
  function inspectTask(id: string) {
    review.close();
    if (useChats.getState().open) useChats.setState({ open: false });
    flushSync(() => setTaskId(id));
    document.getElementById("task-inspector")?.focus({ preventScroll: true });
  }
  function openTask(id: string, showGraph = false) {
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null;
    setGraph(showGraph);
    inspectTask(id);
  }
  usePlannerKeys({
    selectedDay: dateKey,
    deleteTask: (id) => { void mutate.deleteTask(id); },
    inspect: openTask,
    enabled: prefs.keysEnabled,
    bindings: prefs.bindings,
    command: runCommand,
    shift: (by) => {
      if (!section) shift(by);
    },
    help: () => openSettings("keybinds"),
    calendarDay: (key, by) => {
      const d = offsetDay(new Date(key + "T00:00:00"), by);
      go(view, d, false, true);
    },
  });
  const actions = data && {
    plan: data,
    busy,
    mutate,
    open: (task: Task, showGraph = false) => openTask(task.id, showGraph),
  };
  const current = data?.tasks.find((t) => t.id === taskId);

  return (
    <NotebookNavigation.Provider value={{go:runCommand, help:() => openSettings("keybinds")}}>
      <Sidebar
        view={view}
        date={date}
        days={days}
        go={go}
        settings={settingsOpen}
        settingsHref={settingsHref("appearance")}
        openSettings={() => openSettings()}
        reviewOpen={review.open} pendingReview={review.pendingCount} review={showReviewer}
        prefs={prefs}
      />
      {section ? (
        <Settings section={section} navigate={openSettings} prefs={prefs} change={change} />
      ) : (
        <Notebook
          view={view}
          date={date}
          days={days}
          focused={focused}
          selectDay={selectDay}
          focusTarget={focusTarget}
          finishFocus={() => {
            setFocusTarget(null);
            if (captureTarget.current === dateKey) {
              captureTarget.current = null;
              document.getElementById("day-" + dateKey)?.querySelector(".ProseMirror")
                ?.dispatchEvent(new Event("notebook-task"));
            }
          }}
          commands={() => setPalette("commands")}
          inspect={() => current ? closeTask() : setPalette("tasks")}
          inspectorOpen={Boolean(current)}
          onHintStatus={setHintStatus}
          openSettings={openSettings}
          prefs={prefs}
          actions={actions}
          error={current ? "" : error}
          go={go}
          shift={shift}
        />
      )}
      <footer className="planner-status" aria-label="Workspace status">
        <strong className="mode-indicator" data-mode={prefs.keysEnabled ? editorMode : "Editing"}>
          {prefs.keysEnabled ? editorMode : "Editing"}
        </strong>
        <time dateTime={dateKey}>{dateKey}</time>
        <LocalClock />
        <span className="status-keys">{section ? "Settings" : view === "calendar"
          ? prefs.keysEnabled ? "h j k l move" : "Month calendar"
          : prefs.keysEnabled ? editorMode === "Insert" ? "/ commands · Esc normal" : "j/k move · o capture · e details" : "/ commands"}</span>
        <span className="status-state" role="status"><i />{view === "week" && !section ? hintStatus : "Ready"}</span>
        <button type="button" data-chat-launch onClick={() => runCommand("copilot")}><Sparkles size={12}/> Agent</button>
        <button type="button" onClick={() => openSettings("keybinds")}><Keyboard size={13}/> Keymap</button>
      </footer>
      {chatOpen && <Chatbar />}
      {review.open && <ReviewPanel close={closeReviewer} />}
      {palette && <WorkspaceCommands scope={palette} review={showReviewer} prefs={prefs} tasks={data?.tasks ?? []}
        close={() => setPalette(null)} run={runCommand} help={() => openSettings("keybinds")}
        capture={() => {
          captureTarget.current = dateKey;
          go("week", date, view === "week" && focused, true);
        }}
        inspect={(task) => actions?.open(task)} />}
      {!review.open && !chatOpen && !section && current && data && (
        <TaskInspector
          key={current.id}
          plan={data}
          task={current}
          graph={graph}
          showGraph={setGraph}
          select={inspectTask}
          close={closeTask}
          openPlugins={() => openSettings("plugins")}
          mutate={mutate}
          busy={busy}
          error={error}
          day={dateKey}
        />
      )}
    </NotebookNavigation.Provider>
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
    <QueryClientProvider client={queryClient}><App /></QueryClientProvider>
  </StrictMode>,
);
