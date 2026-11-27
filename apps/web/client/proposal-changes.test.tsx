import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { InboxChange } from "@2do/api/agent-inbox";
import { ProposalChanges } from "./proposal-changes.tsx";

const date = "2026-11-27";
const day = { type: "day", date };
const change = (id: string, field: string, before: unknown, after: unknown): InboxChange => ({
  field: "task " + id + " · " + field,
  before,
  after,
});

it("labels the added schedule under each existing task", () => {
  const titles = Object.fromEntries(
    ["Read the notes", "Draft outline", "Pay rent", "Book appointment"].map((title) => [
      crypto.randomUUID(),
      title,
    ]),
  );
  const changes = Object.keys(titles).flatMap((id) => [
    change(id, "currentDay", null, date),
    change(id, "schedule", null, day),
  ]);
  const html = renderToStaticMarkup(<ProposalChanges changes={changes} titles={titles} />);
  for (const [id, title] of Object.entries(titles)) {
    expect(html).toContain(
      '<li><strong class="change-task">' +
        title +
        '</strong><div class="change-line" data-kind="added">',
    );
    expect(html).not.toContain(id);
  }
  expect(html.match(/data-kind="added"/g)).toHaveLength(4);
  expect(html).not.toMatch(/currentDay|Empty|data-kind="removed"|&quot;type&quot;/);
  expect(html.match(/class="change-field-name">Schedule</g)).toHaveLength(4);
  expect(html).not.toContain("Notebook day");
  expect(html).toContain("2026");
});

it("keeps divergent notebook and schedule edits and shows actual removals on their own", () => {
  const id = crypto.randomUUID();
  const html = renderToStaticMarkup(
    <ProposalChanges
      titles={{ [id]: "Write report" }}
      changes={[
        change(id, "currentDay", "2026-11-26", date),
        change(id, "schedule", { type: "day", date: "2026-11-25" }, day),
        change(id, "due", { type: "day", date }, null),
        change(id, "completed", false, true),
      ]}
    />,
  );
  expect(html).toContain("Notebook day");
  expect(html).toContain("Schedule");
  expect(html.match(/data-kind="removed"/g)).toHaveLength(1);
  expect(html).not.toContain('data-kind="added"');
  expect(html).toContain("Open");
  expect(html).toContain("Completed");
});

it("renders structured values, unchanged context and zero without serializing objects", () => {
  const html = renderToStaticMarkup(
    <ProposalChanges
      changes={[
        { field: "Google account", before: "example", after: "example" },
        { field: "Sync directions", before: null, after: { pull: false, push: true, count: 0 } },
        { field: "Amount", before: 0, after: 10 },
      ]}
    />,
  );
  expect(html.match(/data-kind="context"/g)).toHaveLength(1);
  expect(html).toContain("<dt>Pull</dt><dd>No</dd>");
  expect(html).toContain("<dt>Count</dt><dd>0</dd>");
  expect(html).toContain('data-kind="before"');
  expect(html).not.toContain("&quot;");
});

it("shows the created task once, along with useful facts and its classification activity", () => {
  const id = crypto.randomUUID();
  const html = renderToStaticMarkup(
    <ProposalChanges
      changes={[
        {
          field: "task " + id,
          before: null,
          after: {
            id,
            title: "ECE356 Lab 4",
            kind: "task",
            completed: false,
            parentId: null,
            currentDay: null,
            schedule: null,
            durationMinutes: 30,
            createdDate: date,
          },
        },
        { field: "task_classification " + id, before: null, after: { requested: true } },
      ]}
    />,
  );
  expect(html.match(/ECE356 Lab 4/g)).toHaveLength(1);
  expect(html.match(/data-kind="added"/g)).toHaveLength(1);
  expect(html).toContain(
    '<div class="change-value"><strong class="change-task">ECE356 Lab 4</strong></div>',
  );
  expect(html).not.toContain('class="change-field-name"');
  expect(html).toContain("30 min");
  expect(html).toContain("Automatic classification requested");
  expect(html).not.toMatch(/<details|<dl|Add task|None|Parent task|Created on|Task ID/);
  expect(html).not.toContain(id);
});

it("keeps extra edits visible and preserves the whole range for a multi-day schedule", () => {
  const id = crypto.randomUUID();
  const html = renderToStaticMarkup(
    <ProposalChanges
      titles={{ [id]: "Read" }}
      changes={[
        change(id, "currentDay", null, date),
        change(id, "schedule", null, day),
        change(id, "completed", false, true),
      ]}
    />,
  );
  expect(html).toContain('class="change-field-name">Schedule<');
  expect(html).toContain("Status");
  expect(html).toContain("Completed");
  const range = renderToStaticMarkup(
    <ProposalChanges
      titles={{ [id]: "Read" }}
      changes={[
        change(id, "currentDay", null, date),
        change(id, "schedule", null, { ...day, endDateExclusive: "2026-12-02" }),
      ]}
    />,
  );
  expect(range).toContain("Schedule");
  expect(range).toContain("Dec");
});

it("identifies the field on removals and schedule-only additions", () => {
  const id = crypto.randomUUID();
  const removed = renderToStaticMarkup(
    <ProposalChanges
      titles={{ [id]: "Read" }}
      changes={[change(id, "currentDay", date, null), change(id, "schedule", day, null)]}
    />,
  );
  expect(removed).toContain('class="change-field-name">Schedule<');
  expect(removed.match(/data-kind="removed"/g)).toHaveLength(1);
  const timed = renderToStaticMarkup(
    <ProposalChanges titles={{ [id]: "Read" }} changes={[change(id, "schedule", null, day)]} />,
  );
  expect(timed).toContain('class="change-field-name">Schedule<');
  const notebookOnly = renderToStaticMarkup(
    <ProposalChanges titles={{ [id]: "Read" }} changes={[change(id, "currentDay", null, date)]} />,
  );
  expect(notebookOnly).toContain('class="change-field-name">Notebook day<');
});
