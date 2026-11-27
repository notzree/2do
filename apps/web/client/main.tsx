import { currentAgents, notebookReturnHref, openAgents, returnToNotebook } from "./agents-navigation.ts";
import { AgentsWorkspaceView } from "./agents-workspace.tsx";
import { LazyChatbar } from "./lazy-chatbar.tsx";
import { NotebookNavigation } from "./commands.ts";
import { selectChat, newSideChat, captureChatTask, useChats, chatClient } from "./chats.ts";
import { QueryClientProvider } from "@tanstack/react-query";
import type { WorkspaceCommandEvent } from "./agent-workspace.ts";
import { recoverDeviceSubmissions } from "./device-delivery.ts";
import { queryClient, getVerifiedScope } from "./query.ts";
import { lazy, Suspense, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import type { Plan, Task } from "@2do/api/plan";
import { flushSync } from "react-dom";
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
import { useInboxCounts } from "./agent-inbox-api.ts";
import { TaskInspector } from "./task-dialog.tsx";
import { useWeekTaskHints } from "./task-summary-api.ts";
import { WeekTaskHints } from "./task-hints.tsx";
import { usePlannerKeys } from "./vim.ts";
import { planQuery, usePlan } from "./use-plan.ts";
import { Settings } from "./settings.tsx";
import { sections, type Section } from "./settings-sections.ts";
import { useReportSettings } from "./plugin-report-api.ts";
import type { Command, Preferences } from "./preferences.ts";
import { closeNotebookPanel, setActivePanel, useWorkspacePanels } from "./workspace-panels.ts";

const DayEditor = lazy(() => import("./day-editor.tsx").then(m => ({ default: m.DayEditor })));

function readLocation() {
  const url = new URL(currentAgents() ? notebookReturnHref() ?? "/app/week" : location.href, location.origin);
  const segment = url.pathname.split("/")[2];
  const params = url.searchParams;
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
  view, date, days, focused, prefs, actions, error, go, shift, focusTarget, finishFocus, selectDay, commands, inspect, inspectorOpen, renderFooter, openSettings,
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
  renderFooter: (hintStatus: string) => ReactNode;
  openSettings: (section: Section) => void;
}) {
  const loose = actions?.plan.tasks.filter((t) => !t.schedule) ?? [];
  const [showLoose, setShowLoose] = useState(true);
  const hints = useWeekTaskHints(view === "week" ? days : [], actions?.plan.tasks ?? [], !focused && showLoose);
  const notebook = (
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
          <WeekTaskHints hints={hints}>
            <Suspense fallback={<p role="status">Opening day editors…</p>}>
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
            </Suspense>
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
  return <>{notebook}{renderFooter(hints.status)}</>;
}

function focusedEditorMode() {
  const active = document.activeElement;
  if (active?.matches("[data-inline-title]")) return "Insert";
  return active?.closest<HTMLElement>(".writing-surface")?.dataset.mode ?? "Normal";
}

function PlannerStatus({ prefs, dateKey, section, view, hintStatus, openNotebookChat, openSettings }: {
  prefs: Preferences;
  dateKey: string;
  section: Section | null;
  view: View;
  hintStatus: string;
  openNotebookChat: () => void;
  openSettings: (section: Section) => void;
}) {
  const [editorMode, setEditorMode] = useState(focusedEditorMode);
  useEffect(() => {
    const modeChanged = (event: Event) => setEditorMode((event as CustomEvent<string>).detail);
    const focusChanged = () => setEditorMode(focusedEditorMode());
    window.addEventListener("notebook-mode", modeChanged);
    window.addEventListener("focusin", focusChanged);
    return () => {
      window.removeEventListener("notebook-mode", modeChanged);
      window.removeEventListener("focusin", focusChanged);
    };
  }, []);
  const mode = prefs.keysEnabled ? editorMode : "Editing";
  let keys = "/ commands";
  if (section) keys = "Settings";
  else if (view === "calendar") keys = prefs.keysEnabled ? "h j k l move" : "Month calendar";
  else if (mode === "Insert") keys = "/ commands · Esc normal";
  else if (mode === "Normal") keys = "j/k move · o capture · e details";
  return (
    <footer className="planner-status" aria-label="Workspace status">
      <strong className="mode-indicator" data-mode={mode}>
        {mode}
      </strong>
      <time dateTime={dateKey}>{dateKey}</time>
      <LocalClock />
      <span className="status-keys">{keys}</span>
      <span className="status-state" role="status"><i />{hintStatus}</span>
      <button type="button" data-chat-launch onClick={openNotebookChat}><Sparkles size={12}/> Quick chat
        {prefs.keysEnabled && <kbd>g {prefs.bindings.copilot}</kbd>}
      </button>
      <button type="button" onClick={() => openSettings("goals")}>Goals</button>
      <button type="button" onClick={() => openSettings("keybinds")}><Keyboard size={13}/> Keymap</button>
    </footer>
  );
}

function openRequestedTask(taskId: string | undefined, cached: Plan | undefined, open: (id: string) => void) {
  if (!taskId) return false;
  const requestedAt = location.href;
  const inspect = (plan: Plan) => {
    if (location.href !== requestedAt || !plan.tasks.some(task => task.id === taskId)) return false;
    open(taskId);
    return true;
  };
  return cached ? inspect(cached) : queryClient.fetchQuery(planQuery).then(inspect);
}

function PlannerView({
  prefs,
  change,
}: {
  prefs: Preferences;
  change: (patch: Partial<Preferences>) => void;
}) {
  const [{ view, date, section, focused }, setLocation] = useState(readLocation);
  const agents=currentAgents();
  useReportSettings();
  const settingsOpen = !agents && section !== null;
  const inboxCounts = useInboxCounts();
  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("inbox");
    if (target) openAgents({page:"item",id:target},true);
  }, []);
  const panel = useWorkspacePanels((s) => s.activePanel);
  const [palette, setPalette] = useState<CommandScope | null>(null);
  const { data, error, busy, mutate } = usePlan(!agents || !!palette || panel?.kind === "task");
  const captureTarget = useRef<string | null>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey ||
          !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "k") return;
      if (document.querySelector("dialog[open]:not(.workspace-commands)")) return;
      event.preventDefault();
      setPalette((current) => current ? null : "commands");
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, []);
  const days = view === "week" && !focused ? weekDays(date, prefs.weekStart) : [date];
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const dateKey = dayKey(date);

  useEffect(() => {
    const pop = () => {
      setFocusTarget(null);
      setLocation(readLocation());
      if(currentAgents()) setActivePanel(null);else closeNotebookPanel();
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (window.location.pathname.replace(/\/$/, "") === "/app/day")
      history.replaceState(null, "", plannerHref("week", date, false));
  }, [date]);
  function go(nextView: View, nextDate: Date, nextFocused = false, focusGrid = false) {
    closeNotebookPanel();
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
    closeNotebookPanel();
    const link = settingsHref(nextSection);
    if (location.pathname + location.search !== link) history.pushState(null, "", link);
    setFocusTarget(null);
    setLocation({ view, date, section: nextSection, focused });
  }
  function runCommand(command: Command) {
    if (command === "agents") return openAgents();
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
    if (command === "copilot") return openNotebookChat();
    go(command, date, false, true);
  }
  function openNotebookChat() {
    const task = document.activeElement?.closest<HTMLElement>("[data-task], .embedded.taskRef");
    captureChatTask(panel?.kind === "task" ? panel.id : task?.dataset.task ?? task?.dataset.id);
    if (agents) returnToNotebook(() => go(view, date, focused));
    selectChat(useChats.getState().selected);
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
  function closeTask(id: string) {
    const active = useWorkspacePanels.getState().activePanel;
    if (active?.kind !== "task" || active.id !== id) return;
    flushSync(() => setActivePanel(null));
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
  function inspectTask(id: string, graph: boolean) {
    flushSync(() => setActivePanel({ kind: "task", id, graph }));
    document.getElementById("task-inspector")?.focus({ preventScroll: true });
  }
  function openTask(id: string, showGraph = false) {
    const active = document.activeElement;
    origin.current = active instanceof HTMLElement && active !== document.body ? active : null;
    inspectTask(id, showGraph);
  }
  function startCapture() {
    captureTarget.current = dateKey;
    go("week", date, view === "week" && focused, true);
  }
  const plannerScope = getVerifiedScope();
  useEffect(() => {
    if (!plannerScope) return;
    const recover = () => { void recoverDeviceSubmissions(plannerScope,chatClient).catch(()=>{}); };
    recover();
    const interval = window.setInterval(recover,30_000);
    window.addEventListener("online",recover);
    return () => {window.clearInterval(interval);window.removeEventListener("online",recover);};
  },[plannerScope]);
  const onDeviceCommand = useEffectEvent(({detail:{action, reply}}:WorkspaceCommandEvent) => {
    switch (action.command) {
      case "graph":
      case "inspectTask":
        reply(openRequestedTask(action.taskId, data, (taskId) => {
          if (section || agents) go(view, date, focused);
          openTask(taskId, action.command === "graph");
        }));
        return;
      case "openConnection": openSettings("connections"); break;
      case "appearance": openSettings("appearance"); break;
      case "settings": openSettings(action.section); break;
      case "inbox": openAgents(action.itemId?{page:"item",id:action.itemId,action:action.inboxAction}:{page:"attention"}); break;
      case "gmailSuggestions":
        openSettings("connections");
        requestAnimationFrame(() => {
          const control = document.getElementById("gmail-suggestions") ?? document.getElementById("connection-gmail");
          control?.scrollIntoView({block:"center"});
          control?.focus({preventScroll:true});
        }); break;
      case "newChat": newSideChat(); break;
      case "switchChat":
        if (!action.chatId || (action.chatId !== "me" && !queryClient.getQueryData<ReadonlyArray<{id:string}>>(["chats"])?.some(c => c.id === action.chatId))) {reply(false);return;}
        selectChat(action.chatId); break;
      case "commands": setPalette("commands"); break;
      case "capture": startCapture(); break;
      case "week":
      case "calendar": go(action.command, action.date ? new Date(action.date + "T00:00:00") : date); break;
      case "editSelection": case "undoDraft": case "redoDraft": reply(false); return;
      default: runCommand(action.command);
    }
    reply(true);
  });
  useEffect(() => {
    const onCommand = (event:Event) => onDeviceCommand(event as WorkspaceCommandEvent);
    window.addEventListener("agent-workspace-command",onCommand);
    return () => window.removeEventListener("agent-workspace-command",onCommand);
  },[]);
  usePlannerKeys({
    selectedDay: dateKey,
    deleteTask: (id) => { void mutate.deleteTask(id); },
    inspect: openTask,
    enabled: prefs.keysEnabled && !agents,
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
  const current = panel?.kind === "task" ? data?.tasks.find((t) => t.id === panel.id) : undefined;

  function renderPanel() {
    switch (panel?.kind) {
      case "chat": return <LazyChatbar />;
      case "task":
        if (section || !current || !data) return null;
        return (
          <TaskInspector
            key={current.id}
            plan={data}
            task={current}
            graph={panel.graph}
            showGraph={(graph) => setActivePanel({ ...panel, graph })}
            select={(id) => inspectTask(id, panel.graph)}
            close={() => closeTask(current.id)}
            openPlugins={() => openSettings("plugins")}
            mutate={mutate}
            busy={busy}
            error={error}
            day={dateKey}
          />
        );
      default: return null;
    }
  }

  function renderFooter(hintStatus: string) {
    return <PlannerStatus prefs={prefs} dateKey={dateKey} section={section} view={view} hintStatus={hintStatus}
      openNotebookChat={openNotebookChat} openSettings={openSettings} />;
  }

  function renderWorkspace() {
    if (agents) return <AgentsWorkspaceView route={agents} runCommand={runCommand} />;
    if (section) return (
        <>
          <Settings section={section} navigate={openSettings} prefs={prefs} change={change} />
          {renderFooter("Ready")}
        </>
    );
    return (
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
          inspect={() => current ? closeTask(current.id) : setPalette("tasks")}
          inspectorOpen={Boolean(current)}
          renderFooter={renderFooter}
          openSettings={openSettings}
          prefs={prefs}
          actions={actions}
          error={current ? "" : error}
          go={go}
          shift={shift}
        />
    );
  }

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
        pendingReview={inboxCounts.data?.needsAction ?? 0} agents={agents}
        prefs={prefs}
      />
      {renderWorkspace()}
      {renderPanel()}
      {palette && <WorkspaceCommands scope={palette} review={()=>openAgents({page:"attention"})} prefs={prefs} tasks={data?.tasks ?? []}
        close={() => setPalette(null)} run={runCommand} help={() => openSettings("keybinds")}
        capture={startCapture}
        inspect={(task) => actions?.open(task)} />}
    </NotebookNavigation.Provider>
  );
}
export default function Planner(props: Parameters<typeof PlannerView>[0]) {
  return <QueryClientProvider client={queryClient}><PlannerView {...props} /></QueryClientProvider>;
}
