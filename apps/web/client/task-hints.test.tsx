import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { task as taskSchema } from "@2do/api/plan";
import { TaskHints } from "./task-hints.tsx";

it("offers details on a task even before any optional prompts are eligible", () => {
  const task = taskSchema.parse({
    id: crypto.randomUUID(),
    revision: 1,
    parentId: null,
    title: "Dinner",
    completed: false,
    kind: "task",
    schedule: null,
    durationMinutes: null,
  });
  const markup = renderToStaticMarkup(<TaskHints task={task} inspect={() => {}} title="Dinner" />);
  expect(markup).toContain('data-task-enrich="true"');
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).toContain("Details");
});
