import { ChartNoAxesColumn, Columns3 } from "lucide-react";
import { TaskTitle } from "./task-title.tsx";
import type { Mutate } from "./use-plan.ts";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Task } from "@2do/api/plan";
import { DailyGoalDetails, PluginReports } from "./plugin-reports.tsx";
import { historyQuery } from "./plugin-report-api.ts";
import { goalsByDay, monthRange } from "./report-format.ts";
import type { Section } from "./settings-sections.ts";
import {
  dayKey,
  formatDate,
  fullDate,
  monthDays,
  offsetDay,
  onDay, dueDay,
  scheduleStart,
  timeRange,
  type WeekStart,
} from "./calendar.ts";
import "./month-calendar.css";

type Props = {
  date: Date;
  weekStart: WeekStart;
  tasks: Task[];
  update: Mutate["updateTask"];
  open: (task: Task) => void;
  select: (day: Date) => void;
  openWeek: () => void;
  openSettings: (section: Section) => void;
};

export function MonthCalendar({ date, weekStart, tasks, update, open, select, openWeek, openSettings }: Props) {
  const [reportsOpen, setReportsOpen] = useState(false);
  const range = monthRange(date);
  const history = useQuery({ ...historyQuery(range.from, range.to), enabled: !reportsOpen });
  const goals = goalsByDay(history.data ?? []);
  const days = monthDays(date, weekStart);
  const selected = dayKey(date);
  const today = dayKey(new Date());
  const scheduled = tasks
    .flatMap((task) =>
      task.parentId === null && task.schedule
        ? [{ task, start: scheduleStart(task.schedule) }]
        : [],
    )
    .sort((a, b) => +a.start - +b.start);
  const nextDay = offsetDay(date, 1);
  const upcoming = scheduled
    .filter(({ task, start }) => !task.completed && start >= nextDay)
    .slice(0, 3);

  return (
    <>
      <section aria-label="Month calendar">
        <div className="calendar-heading">
          <h1>{formatDate(date, { month: "long", year: "numeric" })}</h1>
          <div className="calendar-nav">
            <button className="calendar-open-week" type="button" aria-pressed={reportsOpen} onClick={() => setReportsOpen(!reportsOpen)}>
              <ChartNoAxesColumn size={15} /> Reports
            </button>
            <button
              className="calendar-open-week"
              aria-label={`Open week containing ${fullDate(date)}`}
              onClick={openWeek}
            >
              <Columns3 size={15} />
              Open week
            </button>
          </div>
        </div>
        {reportsOpen ? <PluginReports key={range.from} date={date} weekStart={weekStart}
          manage={() => openSettings("goals")} openPlugins={() => openSettings("plugins")} /> : <div className="calendar-grid">
          {days.slice(0, 7).map((day) => (
            <span className="calendar-weekday" key={day.getDay()}>
              {formatDate(day, { weekday: "short" })}
            </span>
          ))}
          {days.map((day) => {
            const key = dayKey(day);
            const items = tasks.filter(task=>(task.parentId===null || dueDay(task)===key) && onDay(task,day));
            const entries = goals.get(key) ?? [];
            const met = entries.filter(({ entry }) => entry.outcome === "met").length;
            const progress = entries.filter(({ entry }) => entry.outcome === "inProgress").length;
            const unknown = entries.filter(({ entry }) => entry.outcome === "unknown").length;
            const goalSummary = entries.length
              ? (progress === entries.length ? "In progress" : unknown === entries.length ? "Goals unknown" : met + "/" + entries.length + " goals met") : "";
            return (
              <div
                className="calendar-cell"
                key={key}
                data-outside={day.getMonth() !== date.getMonth()}
              >
                <button
                  className="calendar-date-button"
                  data-calendar-day={key}
                  aria-current={key === today ? "date" : undefined}
                  aria-pressed={key === selected}
                  aria-label={`${fullDate(day)}, ${items.length} scheduled` + (goalSummary ? ", " + goalSummary : "")}
                  onClick={() => select(day)}
                >
                  {day.getDate()}
                </button>
                {goalSummary && <span className="calendar-goal-count" aria-hidden="true">{goalSummary}</span>}
                {items.length > 0 && (
                  <ul className="calendar-tasks">
                    {items.map((task) => (
                      <li key={task.id}>
                        {dueDay(task)===key && <small>Due </small>}<TaskTitle task={task} update={update}
                          data-completed={task.completed}
                          title={task.title}
                          onClick={() => open(task)}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>}
      </section>
      {!reportsOpen && history.error && <p role="alert" className="error">{history.error.message} <button onClick={() => void history.refetch()}>Retry goals</button></p>}
      {!reportsOpen && !!history.data?.length && <DailyGoalDetails entries={goals.get(selected) ?? []} day={selected} manage={() => openSettings("goals")} />}
      {!reportsOpen && <section className="calendar-upcoming" aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming</h2>
        {upcoming.length ? (
          <ul>
            {upcoming.map(({ task, start }) => (
              <li key={task.id}>
                <TaskTitle task={task} update={update} onClick={() => open(task)}>
                  <time dateTime={dayKey(start)}>
                    {formatDate(start, { month: "short", day: "numeric" })}
                  </time>
                  <strong>{task.title}</strong>
                  <span>{timeRange(task) || "All day"}</span>
                </TaskTitle>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No upcoming items scheduled.</p>
        )}
      </section>}
    </>
  );
}
