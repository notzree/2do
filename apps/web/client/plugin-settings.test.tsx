import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { TaskPluginInstallation } from "@2do/api/task-plugins";
import { PluginSettings } from "./plugin-settings.tsx";

function render(catalog: TaskPluginInstallation[]) {
  const client = new QueryClient();
  client.setQueryData(["planner", "plugins"], catalog);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PluginSettings />
    </QueryClientProvider>,
  );
}

const study = {
  id: "study",
  label: "Study",
  description: "Record focused study time.",
  enabled: false,
  subtypes: [
    {
      id: "study.session",
      label: "Study session",
      schemaVersion: 1,
      captureCommand: "focus",
      editor: [{ fields: [{ key: "minutes", label: "Minutes studied", kind: "number", min: 0 }] }],
      prompts: [
        {
          id: "duration",
          field: "minutes",
          label: "How long did you study?",
          trigger: "task.completed",
        },
      ],
      classification: { threshold: 0.5, instructions: "Include focused study sessions." },
      actions: [{ id: "record", label: "Record session" }],
    },
  ],
  metrics: [{ id: "study.time", label: "Study time", unit: "minutes", version: 1, reducer: "sum" }],
  facts: [{ id: "study.duration", version: 1, scopes: ["task"] }],
  features: [
    {
      id: "study.view-meals",
      label: "Meals that day",
      subtypeId: "study.session",
      scope: "local-day",
      requires: { id: "nutrition.logged-meal", version: 1 },
    },
  ],
} satisfies TaskPluginInstallation;

it("previews a disabled plugin's fields, classifier, actions, metrics and declared integrations", () => {
  const markup = render([study]);
  for (const value of [
    "Record focused study time.",
    "Disabled",
    "Study session",
    "/focus",
    "Minutes studied",
    "How long did you study?",
    "When completed",
    "Highest score above 50% wins",
    "Include focused study sessions.",
    "Record session",
    "Study time",
    "minutes",
    "study.duration",
    "Meals that day",
    "nutrition.logged-meal",
    "the same local day",
  ])
    expect(markup).toContain(value);
  expect(markup).not.toContain('checked=""');
});

it("previews colliding commands using the name the notebook would assign on enable", () => {
  const other: TaskPluginInstallation = {
    id: "work",
    label: "Work",
    enabled: true,
    subtypes: [
      { id: "work.session", label: "Work session", schemaVersion: 1, captureCommand: "focus" },
    ],
  };
  const preview = render([study, other]);
  expect(preview).toContain("/study.session");
  expect(preview).toContain("/focus");
  const both = render([{ ...study, enabled: true }, other]);
  expect(both).toContain("/study.session");
  expect(both).toContain("/work.session");
  expect(both).not.toContain("/focus");
});

it("renders older catalogs without optional metadata and keeps empty capability sections hidden", () => {
  const markup = render([{ id: "notes", label: "Notes", enabled: true, subtypes: [] }]);
  expect(markup).toContain('aria-label="Enable Notes"');
  expect(markup).toContain('checked=""');
  expect(markup).not.toContain("Plugin integrations");
  expect(markup).not.toContain("Metrics");
  expect(render([])).toContain("No plugins are available.");
});
