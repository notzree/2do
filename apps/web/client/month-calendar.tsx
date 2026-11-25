import { Columns3 } from "lucide-react";
import type { Task } from "@2do/api/plan";
import {
  dayKey,
  formatDate,
  fullDate,
  monthDays,
  offsetDay,
  onDay,
  scheduleStart,
  timeRange,
  type WeekStart,
} from "./calendar.ts";
import "./month-calendar.css";

type Props = {
  date: Date;
  weekStart: WeekStart;
  tasks: Task[];
  open: (task: Task) => void;
  select: (day: Date) => void;
  openWeek: () => void;
};

export function MonthCalendar({ date, weekStart, tasks, open, select, openWeek }: Props) {
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
        <div className="calendar-grid">
          {days.slice(0, 7).map((day) => (
            <span className="calendar-weekday" key={day.getDay()}>
              {formatDate(day, { weekday: "short" })}
            </span>
          ))}
          {days.map((day) => {
            const key = dayKey(day);
            const items = scheduled.filter(({ task }) => onDay(task, day));
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
                  aria-label={`${fullDate(day)}, ${items.length} scheduled`}
                  onClick={() => select(day)}
                >
                  {day.getDate()}
                </button>
                {items.length > 0 && (
                  <ul className="calendar-tasks">
                    {items.map(({ task }) => (
                      <li key={task.id}>
                        <button
                          data-completed={task.completed}
                          title={task.title}
                          onClick={() => open(task)}
                        >
                          {task.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>
      <section className="calendar-upcoming" aria-labelledby="upcoming-heading">
        <h2 id="upcoming-heading">Upcoming</h2>
        {upcoming.length ? (
          <ul>
            {upcoming.map(({ task, start }) => (
              <li key={task.id}>
                <button onClick={() => open(task)}>
                  <time dateTime={dayKey(start)}>
                    {formatDate(start, { month: "short", day: "numeric" })}
                  </time>
                  <strong>{task.title}</strong>
                  <span>{timeRange(task) || "All day"}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No upcoming items scheduled.</p>
        )}
      </section>
    </>
  );
}
