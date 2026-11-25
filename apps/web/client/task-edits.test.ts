import { expect, it } from "vite-plus/test";
import { createTask, task } from "@2do/api/plan";
import { prepareTaskEdit, taskForm } from "./task-edits.ts";

const day = "2026-11-24";
const base = task.parse({
	...createTask.parse({
		title: "Call Sam",
		schedule: {
			type: "fixed",
			start: "2026-11-24T09:00:52-05:00",
			end: "2026-11-24T10:00:17-05:00",
		},
	}),
	id: crypto.randomUUID(),
	revision: 3,
});
const renamed = { ...taskForm(base, day), title: "Call Sam about repairs" };

it("rebases a title edit onto the latest revision without sending old times", () => {
	const current = { ...base, revision: 8, schedule: { type: "day" as const, date: "2026-11-25" } };
	expect(prepareTaskEdit(base, renamed, current)).toEqual({
		status: "ready",
		patch: { title: renamed.title, revision: 8 },
	});
});
it("asks for review when another writer changed the edited field", () => {
	expect(
		prepareTaskEdit(base, renamed, { ...base, title: "Call the garage", revision: 4 }).status,
	).toBe("conflict");
});
it("preserves offsets and seconds stored in an untouched schedule", () => {
	expect(prepareTaskEdit(base, taskForm(base, day), base).status).toBe("unchanged");
});

it("recognizes an already applied edit after the response was lost", () => {
	expect(prepareTaskEdit(base, renamed, { ...base, title: renamed.title, revision: 4 })).toEqual({
		status: "unchanged",
	});
});
