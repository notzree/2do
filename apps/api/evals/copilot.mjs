import assert from "node:assert/strict";
import { copyFile, cp, mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createFlueClient, FlueApiError } from "@flue/sdk";
import { unstable_dev } from "wrangler";
import tools from "../src/mcp/tools.json" with { type: "json" };

const { values: options } = parseArgs({
	options: { smoke: { type: "boolean" }, case: { type: "string" } },
});
if (options.case && !["ideas", "ambiguous", "conflict"].includes(options.case))
	throw new Error("Choose a case from ideas, ambiguous or conflict.");
const run = (name) => !options.smoke && (!options.case || options.case === name);
const bundle = resolve("dist/2do_api");
const built = JSON.parse(await readFile(join(bundle, "wrangler.json"), "utf8"));
const directory = await mkdtemp(join(tmpdir(), "2do-copilot-eval-"));
const config = join(directory, "wrangler.json");
const smoke = options.smoke;
const readTools = new Set(
	tools.filter((tool) => tool.annotations.readOnlyHint).map((tool) => tool.name),
);
let worker;
try {
	const modules = join(directory, "modules");
	await mkdir(modules);
	await copyFile(join(bundle, built.main), join(modules, "index.js"));
	await cp(join(bundle, "assets"), join(modules, "assets"), {
		recursive: true,
		filter: (file) => !file.endsWith(".map"),
	});
	const entry = join(modules, "worker.mjs");
	await copyFile(new URL("./conflict-worker.mjs", import.meta.url), entry);
	await writeFile(
		config,
		JSON.stringify({
			name: "2do-copilot-eval",
			main: entry,
			base_dir: modules,
			no_bundle: true,
			find_additional_modules: true,
			rules: [
				{ type: "ESModule", globs: ["**/*.js"] },
				{ type: "Text", globs: ["**/*.sql"], fallthrough: false },
			],
			compatibility_date: built.compatibility_date,
			compatibility_flags: built.compatibility_flags,
			durable_objects: built.durable_objects,
			migrations: built.migrations,
			r2_buckets: built.r2_buckets,
			vars: { ...built.vars, LOCAL_PLANNER: "enabled" },
			...(!smoke && { ai: { binding: "AI", remote: true } }),
		}),
	);
	worker = await unstable_dev(entry, {
		config,
		persistTo: join(directory, "state"),
		logLevel: "warn",
		experimental: { disableDevRegistry: true, watch: false, disableExperimentalWarning: true },
	});
	const url = "http://127.0.0.1:" + worker.port + "/api/";
	async function api(path, method = "GET", body) {
		const response = await fetch(url + path, {
			method,
			...(body && { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
		});
		assert.ok(response.ok, method + " " + path + " returned " + response.status);
		return response.json();
	}
	async function conversation(title) {
		const id = crypto.randomUUID();
		await api("chats/" + id, "PUT", { title });
		return createFlueClient({ url: url + "agents/copilot/" + id });
	}
	async function turn(chat, text) {
		const receipt = await chat.send({
			message: { kind: "user", body: "[Planner date 2026-11-24, America/Toronto]\n\n" + text },
		});
		const calls = [];
		const inputs = [];
		const reply = await chat.read(receipt, {
			signal: AbortSignal.timeout(300_000),
			onEvent: (event) => {
				if (event.type === "tool-input") {
					const name = event.toolName.split("__").at(-1);
					calls.push(name);
					console.log("  Copilot called " + name);
					inputs.push(event.input);
				}
			},
		});
		assert.ok(reply.text.trim(), "Expected an assistant reply");
		return { text: reply.text, calls, inputs };
	}
	function assertReadsOnly(turn) {
		assert.ok(
			turn.calls.every((call) => readTools.has(call)),
			"Expected read-only tools. Observed " +
				JSON.stringify(turn.calls.map((name, index) => ({ name, input: turn.inputs[index] }))),
		);
	}

	assert.equal((await api("tasks")).tasks.length, 0);
	const first = await api("tasks", "POST", {
		title: "Confirm train tickets",
		schedule: { type: "day", date: "2026-11-24" },
	});
	await api("tasks", "POST", {
		title: "Confirm train tickets",
		schedule: { type: "day", date: "2026-11-28" },
	});
	if (smoke) {
		const ideas = await conversation("Planning ideas");
		// Flue creates the event stream only when the first prompt is admitted.
		await assert.rejects(
			ideas.history(),
			(error) =>
				error instanceof FlueApiError &&
				error.status === 404 &&
				error.body?.error?.type === "stream_not_found",
		);
		console.log("Built Worker, synthetic planner and Flue conversation are ready.");
	}
	const before = await api("tasks");
	if (run("ideas")) {
		const ideas = await conversation("Planning ideas");
		const suggestion = await turn(ideas, "Any ideas for organizing my travel planning this week?");
		assertReadsOnly(suggestion);
		assert.deepEqual(await api("tasks"), before);
		console.log("Passed planning ideas without writes");
	}
	if (run("ambiguous")) {
		const ambiguous = await conversation("Ambiguous task");
		const answer = await turn(ambiguous, "Mark Confirm train tickets as done.");
		assertReadsOnly(answer);
		assert.ok(answer.calls.includes("searchTasks"), "Expected a bounded task lookup");
		assert.match(answer.text, /\?|which|clarif/i);
		assert.deepEqual(await api("tasks"), before);
		console.log("Passed ambiguous title clarification");
	}
	if (run("conflict")) {
		const editor = await conversation("Concurrent edit");
		const task = await api("tasks", "POST", { title: "Draft repair estimate" });
		const changed = await turn(editor, "Rename Draft repair estimate to Send repair estimate.");
		const firstAttempt = changed.calls.indexOf("updateTask");
		const lastAttempt = changed.calls.lastIndexOf("updateTask");
		assert.ok(
			firstAttempt >= 0 && lastAttempt > firstAttempt,
			"Expected a retry after a stale write: " + changed.calls,
		);
		assert.ok(
			changed.calls
				.slice(firstAttempt + 1, lastAttempt)
				.some((call) => ["getTask", "readTaskDetails", "searchTasks", "listTasks"].includes(call)),
			"Expected a fresh read before retrying: " + changed.calls,
		);
		const saved = await api("tasks/" + task.id);
		assert.equal(saved.title, "Send repair estimate");
		assert.deepEqual(saved.schedule, { type: "day", date: "2026-12-03" });
		assert.deepEqual(await api("tasks/" + first.id), first);
		console.log("Passed rename with intervening schedule change");
	}
} finally {
	try {
		await worker?.stop();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}
