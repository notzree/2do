import { describe, expect, it } from "vite-plus/test";
import { maxRawInputLength, type NewTask } from "@2do/api/notebook";
import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { editorExtensions } from "./editor-extensions.ts";
import { dayKey } from "./calendar.ts";
import { commands, notebookCommands, type SlashCommand } from "./commands.ts";
import {
	slashInput,
	slashKeyDown,
	slashOptions,
	slashPlugin,
	type SlashActions,
} from "./slash-editor.ts";

const schema = getSchema(editorExtensions());
function editor(text: string, offset = text.length, catalog: readonly SlashCommand[] = commands) {
	const doc = schema.node("doc", null, [
		schema.node("paragraph", null, text ? schema.text(text) : undefined),
	]);
	let state = EditorState.create({
		doc,
		selection: TextSelection.create(doc, 1 + offset),
		plugins: [slashPlugin],
	});
	const created: string[] = [];
	const captures: NewTask[] = [];
	const chats: string[] = [];
	const actions: SlashActions = {
		commands: catalog,
		tasks: [],
		navigate() {},
		image() {},
		carryover() {},
		chat(name, body) {
			chats.push(name + ":" + body);
			return true;
		},
	};
	const view = {
		get state() {
			return state;
		},
		dispatch(tr: typeof state.tr) {
			const task = tr.getMeta("newTask");
			if (task) {
				created.push(task.title);
				captures.push(task);
			}
			state = state.apply(tr);
		},
	};
	return {
		view,
		actions,
		created,
		captures,
		chats,
		key(key: string, options: Partial<KeyboardEvent> = {}) {
			return slashKeyDown(view as EditorView, { key, ...options } as KeyboardEvent, actions);
		},
		type(text: string) {
			view.dispatch(state.tr.insertText(text));
		},
	};
}

describe("inline slash commands", () => {
	it("executes carryover once and removes the slash command from the page", () => {
		const e = editor("/carryover");
		let calls = 0;
		e.actions.carryover = () => { calls++; };
		expect(e.key("Enter")).toBe(true);
		expect(calls).toBe(1);
		expect(e.view.state.doc.textContent).toBe("");
		expect(e.captures).toEqual([]);
	});
	const nutrition = {
		id: "nutrition",
		label: "Nutrition",
		enabled: true,
		subtypes: [{ id: "nutrition.meal", label: "Meal", captureCommand: "meal", schemaVersion: 1 }],
	};
	it("uses the enabled command descriptor for both menu and pasted typed captures", () => {
		const catalog = notebookCommands([nutrition]);
		const e = editor("/me", 3, catalog);
		expect(
			slashOptions(slashInput(e.view.state, catalog)!, [], catalog).map((x) => x.label),
		).toEqual(["/meal"]);
		e.key("Tab");
		e.type(" dinner at Nuri Village ");
		e.key("Enter");
		expect(e.captures).toHaveLength(1);
		expect(e.captures[0]).toMatchObject({
			typeId: "nutrition.meal",
			rawInput: " dinner at Nuri Village ",
		});
		const pasted = editor("/meal Sushi", 11, catalog);
		pasted.key("Enter");
		expect(pasted.captures[0]).toMatchObject({ typeId: "nutrition.meal", title: "Sushi" });
	});
	it("keeps the draft text if a typed command disappears while editing", () => {
		const e = editor("/me", 3, notebookCommands([nutrition]));
		e.key("Tab");
		e.type("Dinner");
		e.actions.commands = notebookCommands([{ ...nutrition, enabled: false }]);
		expect(e.key("Enter")).toBe(false);
		expect(e.view.state.doc.textContent).toBe("/meal Dinner");
		expect(e.captures).toEqual([]);
	});
	it("uses a namespaced spelling when two plugins request the same shortcut", () => {
		const other = {
			id: "travel",
			label: "Travel",
			enabled: true,
			subtypes: [
				{ id: "travel.meal", label: "Travel meal", captureCommand: "meal", schemaVersion: 1 },
			],
		};
		const catalog = notebookCommands([nutrition, other]);
		const names = catalog.filter((c) => c.kind === "typed").map((c) => c.name);
		expect(names).toEqual(["nutrition.meal", "travel.meal"]);
		const e = editor("/travel.meal Lunch", 18, catalog);
		e.key("Enter");
		expect(e.captures[0]?.typeId).toBe("travel.meal");
	});
	it("converts a heading into an editable note while retaining the surrounding text", () => {
		const e = editor("Notes /note", 11);
		e.view.dispatch(e.view.state.tr.setBlockType(1, 1, schema.nodes.heading));
		e.key("Enter");
		e.type("for Friday");
		expect(e.view.state.doc.firstChild?.type.name).toBe("paragraph");
		expect(e.view.state.doc.textContent).toBe("Notes for Friday");
		expect(e.captures).toEqual([]);
	});
	it.each([" ", "Tab", "Enter"])(
		"accepts a prefix with %j and creates a task once on submit",
		(key) => {
			const e = editor("Before /ta after", 10);
			expect(e.view.state.doc.textContent).toBe("Before /ta after");
			expect(e.key(key)).toBe(true);
			expect(e.created).toEqual([]);
			expect(e.view.state.doc.textContent).toBe("Before /task  after");
			e.type("Buy milk / eggs");
			expect(e.key("Enter")).toBe(true);
			expect(e.created).toEqual(["Buy milk / eggs"]);
			expect(e.view.state.doc.toJSON().content.map((b: { type: string }) => b.type)).toEqual([
				"paragraph",
				"taskRef",
				"paragraph",
			]);
			expect(e.view.state.doc.firstChild?.textContent).toBe("Before ");
			expect(e.view.state.doc.lastChild?.textContent).toBe(" after");
			expect(e.key("Enter")).toBe(false);
		},
	);
	it("keeps draft edits in range when the caret moves inside the title", () => {
		const e = editor("/ta");
		e.key("Tab");
		e.type("Buy milk");
		e.view.dispatch(e.view.state.tr.setSelection(TextSelection.create(e.view.state.doc, 11)));
		e.type("oat ");
		e.key("Enter");
		expect(e.created).toEqual(["Buy oat milk"]);
	});
	it.each(["/main", "/unknown", "https://example.com", "3/4", "src/tasks"])(
		"preserves literal text %s",
		(text) => {
			const e = editor(text);
			expect(e.key("Enter")).toBe(false);
			expect(e.view.state.doc.textContent).toBe(text);
		},
	);
	it("dismisses suggestions with Escape and leaves the text editable", () => {
		const e = editor("/ta");
		e.key("Escape");
		expect(e.key("Enter")).toBe(false);
		expect(e.view.state.doc.textContent).toBe("/ta");
	});
	it("can finish a saved draft and validates the raw capture before replacing it", () => {
		const e = editor("/task Pick up groceries");
		e.key("Enter");
		expect(e.created).toEqual(["Pick up groceries"]);
		const empty = editor("/task ");
		empty.key("Enter");
		expect(empty.created).toEqual([]);
		const long = editor("/task " + "x".repeat(maxRawInputLength + 1));
		long.key("Enter");
		expect(long.created).toEqual([]);
	});
	it("captures verbatim input and local date and zone without swallowing IME confirmation", () => {
		const raw = "  手伝って　 金曜日  ";
		const e = editor("/task " + raw);
		expect(e.key("Enter", { isComposing: true })).toBe(false);
		expect(e.captures).toEqual([]);
		expect(e.view.state.doc.textContent).toBe("/task " + raw);
		e.key("Enter");
		expect(e.captures).toEqual([
			{
				id: e.view.state.doc.firstChild?.attrs.id,
				title: raw.trim(),
				rawInput: raw,
				captureDate: dayKey(new Date()),
				timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			},
		]);
		e.type("Next note");
		expect(e.view.state.doc.lastChild?.textContent).toBe("Next note");
		expect(e.key("Enter")).toBe(false);
	});
	it("keeps the complete source of a capture with a long display title", () => {
		const source = "a".repeat(238) + "🎉 next";
		const e = editor("/task " + source);
		e.key("Enter");
		expect(e.captures[0].rawInput).toBe(source);
		expect(e.captures[0].title.length).toBeLessThanOrEqual(240);
		expect(e.captures[0].title).not.toContain("�");
	});
	it("opens chat on bare Enter and accepts a natural-language message inline", () => {
		const main = editor("Keep this /ag");
		main.key(" ");
		main.type("Plan my day");
		main.key("Enter");
		expect(main.chats).toEqual(["agent:Plan my day"]);
		expect(main.view.state.doc.textContent).toBe("Keep this ");
		const side = editor("/si");
		side.key("Enter");
		expect(side.chats).toEqual(["side:"]);
	});
	it("offers multiword navigation commands at the caret", () => {
		const e = editor("/next-w");
		expect(slashOptions(slashInput(e.view.state)!, []).map((x) => x.label)).toEqual(["/next week"]);
	});
});

it("captures a standalone goal reference and passes the declared activity alias through capture",()=>{
  const goal=editor("/goal Feel ready for interviews");
  goal.key("Enter");
  expect(goal.view.state.doc.firstChild?.type.name).toBe("goalRef");
  expect(goal.captures).toEqual([]);
  const catalog=notebookCommands([{id:"fitness",label:"Fitness",enabled:true,subtypes:[{id:"fitness.activity",label:"Activity",schemaVersion:1,captureCommand:"activity",captureAliases:["sport"]}]}]);
  const sport=editor("/sport Volleyball",undefined,catalog);
  sport.key("Enter");
  expect(sport.captures).toMatchObject([{typeId:"fitness.activity",alias:"sport",rawInput:"Volleyball"}]);
});
