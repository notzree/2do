import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import { task as taskSchema } from "@2do/api/plan";
import { pluginInstallations, type TaskSubtypeEditor } from "@2do/api/task-plugins";
import { PromptFields, TaskSubtypes } from "./task-subtypes.tsx";

const task = taskSchema.parse({
  id: crypto.randomUUID(),
  revision: 1,
  parentId: null,
  title: "Prepare session",
  completed: false,
  kind: "task",
  schedule: null,
  durationMinutes: null,
});

function renderPrompt(pluginId: string, editor: TaskSubtypeEditor, field: string) {
  const typeId = pluginId + ".session";
  const client = new QueryClient();
  const prompt = { id: "prepare", label: "Prepare", trigger: "task.open" as const, field };
  client.setQueryData(
    ["planner", "plugins"],
    pluginInstallations.parse([
      {
        id: pluginId,
        label: pluginId,
        enabled: true,
        subtypes: [{ id: typeId, label: "Session", schemaVersion: 1, editor, prompts: [prompt] }],
      },
    ]),
  );
  client.setQueryData(["planner", "details", task.id], {
    task,
    classification: "idle",
    subtypes: [
      { typeId, data: {}, schemaVersion: 1, source: "manual", revision: crypto.randomUUID() },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PromptFields task={task} prompt={{ ...prompt, typeId, id: typeId + "." + prompt.id }} />
    </QueryClientProvider>,
  );
}

it("renders a Study list prompt inline without unrelated numeric fields", () => {
  const markup = renderPrompt(
    "study",
    [
      {
        fields: [
          { key: "topics", kind: "text-list", label: "Target topics", maxItems: 8, maxLength: 100 },
          { key: "minutes", kind: "number", label: "Duration", min: 0 },
        ],
      },
    ],
    "topics",
  );
  expect(markup).toContain("Target topics");
  expect(markup).toContain("<textarea");
  expect(markup).not.toContain("Duration");
});

it("keeps co-required fields together when a single nested field supplies the hint", () => {
  const markup = renderPrompt(
    "health",
    [
      {
        key: "duration",
        requiredTogether: true,
        fields: [
          { key: "active", kind: "number", label: "Active minutes", min: 0 },
          { key: "total", kind: "number", label: "Total minutes", min: 0 },
        ],
      },
    ],
    "duration.active",
  );
  expect(markup).toContain("Active minutes");
  expect(markup).toContain("Total minutes");
});

function renderTypes(enabled: boolean, details: object) {
  const client = new QueryClient();
  client.setQueryData(
    ["planner", "plugins"],
    [
      {
        id: "study",
        label: "Study",
        enabled,
        subtypes: [{ id: "study.session", label: "Session", schemaVersion: 1 }],
      },
    ],
  );
  client.setQueryData(["planner", "details", task.id], {
    task,
    subtypes: [],
    classification: "idle",
    ...details,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TaskSubtypes task={task} active openPlugins={() => {}} />
    </QueryClientProvider>,
  );
}

it("shows a recorded no-match result separately from a task awaiting its first classification", () => {
  const initial = renderTypes(true, {});
  expect(initial).toContain("Classify task");
  expect(initial).not.toContain("No matching types");
  const checked = renderTypes(true, {
    lastClassification: {
      checkedAt: "2026-11-24T11:00:00Z",
      evaluated: ["study.session"],
      matched: [],
    },
  });
  expect(checked).toContain("No matching types");
  expect(checked).toContain("Recheck types");
  expect(checked).toContain("2026-11-24T11:00:00Z");
});

it("offers the relevant action for disabled, failed and pending classification", () => {
  expect(renderTypes(false, {})).toContain("Enable plugins");
  expect(renderTypes(true, { classification: "failed" })).toContain("Retry classification");
  const pending = renderTypes(true, { classification: "pending" });
  expect(pending).toContain("Clef is checking");
  expect(pending).not.toContain("Classify task");
});

it("identifies manual types and suppresses redundant reclassification", () => {
  const confirmed = renderTypes(true, {
    subtypes: [
      {
        typeId: "study.session",
        source: "manual",
        data: {},
        revision: crypto.randomUUID(),
        schemaVersion: 1,
      },
    ],
  });
  expect(confirmed).toContain("User-confirmed");
  expect(confirmed).not.toContain("Classify task");
  expect(confirmed).not.toContain("Inferred by Clef");
});

it.each(["manual", "automatic"] as const)(
  "offers all %s subtype fields and other enabled types in the compact panel",
  (source) => {
    const client = new QueryClient();
    client.setQueryData(
      ["planner", "plugins"],
      [
        {
          id: "study",
          label: "Study",
          enabled: true,
          subtypes: [
            {
              id: "study.session",
              label: "Session",
              schemaVersion: 1,
              editor: [
                {
                  fields: [
                    {
                      key: "topics",
                      kind: "text-list",
                      label: "Target topics",
                      maxItems: 8,
                      maxLength: 100,
                    },
                  ],
                },
              ],
            },
            { id: "study.exam", label: "Exam", schemaVersion: 1 },
          ],
        },
        {
          id: "disabled",
          label: "Disabled",
          enabled: false,
          subtypes: [{ id: "disabled.type", label: "Hidden type", schemaVersion: 1 }],
        },
      ],
    );
    client.setQueryData(["planner", "details", task.id], {
      task,
      classification: "idle",
      subtypes: [
        {
          typeId: "study.session",
          source,
          data: { topics: ["Math"] },
          revision: crypto.randomUUID(),
          schemaVersion: 1,
        },
      ],
    });
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <TaskSubtypes task={task} active openPlugins={() => {}} compact />
      </QueryClientProvider>,
    );
    expect(markup).toContain("Edit Session details");
    expect(markup).toContain("Target topics");
    expect(markup).toContain("Math");
    expect(markup).toContain("Add Exam");
    expect(markup).not.toContain("Hidden type");
    expect(markup).toContain(source === "manual" ? "User-confirmed" : "Inferred by Clef");
  },
);
