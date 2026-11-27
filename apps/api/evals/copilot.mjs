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
if (
  options.case &&
  !["ideas", "ambiguous", "conflict", "brief", "routine", "device", "placement", "scheduling"].includes(options.case)
)
  throw new Error("Choose a case from ideas, ambiguous, conflict, brief, routine, device, placement or scheduling.");
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
    return { text: reply.text, calls, inputs, submissionId: receipt.submissionId };
  }
  function assertReadsOnly(turn) {
    assert.ok(
      turn.calls.every(
        (call) => readTools.has(call) || ["activate_skill", "read_skill_file"].includes(call),
      ),
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
    assertReadsOnly({ ...answer, calls: answer.calls.filter((name) => name !== "askUser") });
    assert.ok(answer.calls.includes("askUser"), "Clarification must survive closing chat");
    assert.ok(answer.calls.includes("searchTasks"), "Expected a bounded task lookup");
    const pending = (await api("agent/inbox?view=action")).items.find(
      (item) => item.kind === "question",
    );
    assert.ok(pending?.conversation, "Question is attached to its chat");
    assert.ok(pending.choices.length >= 2, "Show both plausible matches");
    assert.deepEqual(await api("tasks"), before);
    const selected = pending.choices[0];
    await api("agent/inbox/" + pending.id + "/decision", "POST", {
      version: pending.version,
      decision: "answer",
      answer: selected,
    });
    // Only the planner outbox can wake this conversation. No new browser chat
    // submission is made after the answer.
    const deadline = Date.now() + 180_000;
    let proposal;
    while (Date.now() < deadline) {
      const items = (await api("agent/inbox?view=action")).items;
      proposal = items.find(
        (item) =>
          item.kind === "proposal" &&
          item.conversation === pending.conversation &&
          item.changes.some(
            (change) => change.field.endsWith(" · completed") && change.after === true,
          ),
      );
      if (proposal) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(proposal, "Expected the resumed conversation to issue its change proposal");
    assert.deepEqual(await api("tasks"), before);
    await api("agent/inbox/" + proposal.id + "/decision", "POST", {
      version: proposal.version,
      decision: "approve",
    });
    assert.equal((await api("tasks")).tasks.filter((task) => task.completed).length, 1);
    console.log("Passed durable question, server-side resume and approved edit");
  }
  if (run("conflict")) {
    const editor = await conversation("Concurrent edit");
    const unrelatedBefore = await api("tasks/" + first.id);
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
    const pending = (await api("agent/inbox?view=action")).items.find(
      (item) =>
        item.kind === "proposal" &&
        item.changes.some((change) => change.after === "Send repair estimate"),
    );
    assert.ok(pending, "Expected a reviewable rename");
    assert.equal((await api("tasks/" + task.id)).title, task.title);
    const outcome = await api("agent/inbox/" + pending.id + "/decision", "POST", {
      version: pending.version,
      decision: "approve",
    });
    assert.equal(outcome.status, "applied");
    const saved = await api("tasks/" + task.id);
    assert.equal(saved.title, "Send repair estimate");
    assert.deepEqual(saved.schedule, { type: "day", date: "2026-12-03" });
    assert.deepEqual(await api("tasks/" + first.id), unrelatedBefore);
    console.log("Passed rename with intervening schedule change");
  }
  if (run("placement")) {
    const titles = ["Pack the display samples", "File the workshop receipt"];
    const steps = titles.map(title => ({
      operation: "createTask", args: {requestBody: {id: crypto.randomUUID(), title}},
    }));
    const proposal = await api("agent/changes", "POST", {
      id: crypto.randomUUID(), title: "Add workshop tasks", reason: "Requested list", steps,
    });
    await api("agent/inbox/" + proposal.id + "/decision", "POST", {version: proposal.version, decision: "approve"});
    const saved = (await api("tasks")).tasks.filter(task => titles.includes(task.title));
    assert.equal(saved.length, titles.length);
    assert.ok(saved.every(task => !task.schedule && !task.currentDay && !task.due));
    const chat = await conversation("Finding a saved task");
    const reply = await turn(chat, "I approved Pack the display samples and File the workshop receipt. Where in the planner can I see them?");
    assertReadsOnly(reply);
    assert.ok(reply.calls.some(call => ["listTasks", "getTask", "searchTasks"].includes(call)), "Read the saved tasks before describing their placement");
    assert.match(reply.text, /unscheduled/i);
    assert.match(reply.text, /week/i);
    console.log("Passed approved task placement in Week → Unscheduled");
  }
  if (run("scheduling")) {
    const chat = await conversation("Capture and schedule");
    const chatId = chat.url.split("/").at(-1);
    await turn(chat, "Add these todos: Pack prototype samples and Print workshop badges.");
    const actions = async () => (await api("agent/inbox?view=action")).items.filter(item => item.conversation === chatId);
    const proposals = await actions();
    assert.ok(proposals.length && proposals.every(item => item.kind === "proposal"), "Ordinary todos need no time question");
    for (const item of proposals) await api("agent/inbox/" + item.id + "/decision", "POST", {version:item.version, decision:"approve"});
    const added = (await api("tasks")).tasks.filter(task => /prototype samples|workshop badges/i.test(task.title));
    assert.equal(added.length, 2);
    for (const task of added) {
      assert.deepEqual(task.schedule, {type:"day", date:"2026-11-24"});
      assert.equal(task.currentDay, "2026-11-24");
    }
    const eventChat = await conversation("Book a timed event");
    const eventChatId = eventChat.url.split("/").at(-1);
    const request = await turn(eventChat, "Schedule a 30-minute design review on Friday.");
    assert.ok(request.calls.includes("askUser"), "Ask for the missing start time");
    const pending = (await api("agent/inbox?view=action")).items.filter(item => item.conversation === eventChatId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, "question");
    assert.match([pending[0].title,pending[0].body,...pending[0].choices].join(" "), /time|when|start|[ap]m/i);
    assert.ok(!(await api("tasks")).tasks.some(task => /design review/i.test(task.title)));
    console.log("Passed local-day todo capture and missing event start time");
  }
  if (run("device")) {
    const chat = await conversation("Device command");
    const outcome = await turn(chat, "Open Month view in my current browser.");
    assert.ok(outcome.calls.includes("showWorkspace"));
    const { messages } = await chat.history();
    const call = messages
      .filter((m) => m.submissionId === outcome.submissionId)
      .flatMap((m) => m.parts)
      .find(
        (p) =>
          p.type === "dynamic-tool" &&
          p.toolName === "showWorkspace" &&
          p.state === "output-available",
      );
    assert.ok(call, "Workspace call must be readable from the browser transcript");
    assert.equal(call.output.clientCommand.command, "calendar");
    assert.equal(call.output.status, "awaiting_device");
    const scope = (await fetch(url + "tasks")).headers.get("X-Planner-Scope");
    const chatId = chat.url.split("/").at(-1);
    const receipt = {
      submissionId: outcome.submissionId,
      toolCallId: call.toolCallId,
      status: "applied",
      label: "Opened Month in the submitting tab.",
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const ack = await fetch(url + "chats/" + chatId + "/device-receipt", {
        method: "POST",
        headers: { "content-type": "application/json", "X-Planner-Scope": scope },
        body: JSON.stringify(receipt),
      });
      assert.equal(ack.status, 202);
    }
    console.log("Passed workspace command and replayed authenticated device receipt");
  }
  if (run("brief")) {
    const date = new Date().toISOString().slice(0, 10);
    for (const title of ["Prepare synthetic agenda", "Submit synthetic morning report"]) {
      await api("tasks", "POST", { title, schedule: { type: "day", date } });
    }
    const id = crypto.randomUUID();
    await api("reminders/" + id, "PUT", {
      title: "Synthetic scheduled briefing",
      enabled: true,
      trigger: { kind: "daily", time: "09:00", summary: "agenda", synthesize: true },
    });
    const deadline = Date.now() + 60_000;
    let result;
    do {
      result = (await api("reminders?evalBriefResult=1")).result;
      if (result) break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    assert.ok(result?.ok, "Expected a validated Flue callback before the fallback deadline");
    assert.ok(result.order.length > 0, "Expected at least one selected task");
    const items = (await api("agent/inbox?view=updates")).items.filter(
      (item) => item.reminderId === id,
    );
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "notification");
    console.log("Passed live scheduled Flue brief with one informational inbox item");
  }

  if (run("routine")) {
    const task = await api("tasks", "POST", { title: "Synthetic routine record" });
    const policy = await api("agent/approval");
    await api("agent/approval", "PUT", {
      revision: policy.revision,
      rules: [
        { effect: "local-edit", origin: "chat", mode: "ask" },
        {
          effect: "local-edit",
          origin: "scheduled",
          mode: "allow",
          operations: ["updateTask"],
          resourceIds: [task.id],
        },
      ],
    });
    const id = crypto.randomUUID();
    await api("reminders/" + id, "PUT", {
      title: "Synthetic policy routine",
      enabled: true,
      trigger: {
        kind: "routine",
        time: "09:00",
        instruction:
          "Set the title of record " +
          task.id +
          " to Synthetic daily review. Fetch the current task revision and update only its title.",
      },
    });
    const deadline = Date.now() + 110_000;
    let saved;
    do {
      saved = await api("tasks/" + task.id);
      if (saved.title === "Synthetic daily review") break;
      await new Promise((resolve) => setTimeout(resolve, 750));
    } while (Date.now() < deadline);
    assert.equal(
      saved.title,
      "Synthetic daily review",
      "Expected the scheduled agent to apply its scoped edit",
    );
    const items = (await api("agent/inbox")).items;
    assert.ok(
      items.some(
        (item) =>
          item.status === "applied" &&
          item.changes.some((change) => change.after === "Synthetic daily review"),
      ),
    );
    console.log(
      "Passed authenticated routine configuration, scheduled Flue execution and scoped automatic edit",
    );
  }
} finally {
  try {
    await worker?.stop();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
