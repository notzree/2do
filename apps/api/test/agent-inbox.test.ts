import type { ConnectorEnv } from "../src/connectors/connection.ts";
import { env } from "cloudflare:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vite-plus/test";
import { plannerConnection, setAgentTurn } from "../src/mcp/connection.ts";
import type { InboxItem, InboxPage } from "../src/interfaces/agent-inbox.ts";

function fixture() {
  const owner = crypto.randomUUID(),
    stub = env.USER_PLANNER.getByName(owner);
  const api = (path: string, method = "GET", body?: object) =>
    stub.fetch("https://planner.test/api/" + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body && { body: JSON.stringify(body) }),
    });
  const decide = (item: InboxItem, decision: string, answer?: string) =>
    api("agent/inbox/" + item.id + "/decision", "POST", {
      version: item.version,
      decision,
      answer,
    });
  async function connect() {
    const config = plannerConnection(env.USER_PLANNER, owner, owner);
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(config.url), { fetch: config.fetch }),
    );
    return client;
  }
  return { owner, api, decide, connect };
}
it("keeps notification read state independent of pending work and binds question answers", async () => {
  const { api, decide } = fixture();
  const question = await (
    await api("agent/questions", "POST", {
      id: crypto.randomUUID(),
      title: "Which event?",
      body: "Choose one.",
      choices: ["Lab", "Meeting"],
    })
  ).json<InboxItem>();
  const notice = await (
    await api("agent/notifications", "POST", {
      id: crypto.randomUUID(),
      title: "New schedule",
      body: "Lab starts at 4 PM.",
    })
  ).json<InboxItem>();
  await api("agent/inbox/" + question.id, "PATCH", { read: true });
  expect(await (await api("agent/inbox")).json()).toMatchObject({ unread: 1, needsAction: 1 });
  expect(await (await api("agent/inbox-counts")).json()).toEqual({ unread: 1, needsAction: 1 });
  const cards = await (await api("agent/inbox-items", "POST", { ids: [question.id, notice.id, "absent"] })).json<InboxItem[]>();
  expect(cards.map(item => item.id).sort()).toEqual([question.id, notice.id].sort());
  expect((await api("agent/inbox/" + question.id, "PATCH", { archived: true })).status).toBe(409);
  const action = await (await api("agent/inbox?view=action")).json<InboxPage>();
  expect(action.items.map((i) => i.id)).toEqual([question.id]);
  expect((await decide(notice, "approve")).status).toBe(409);
  expect(await (await decide(question, "answer", "Lab")).json()).toMatchObject({
    status: "answered",
    answer: "Lab",
  });
  expect((await decide(question, "answer", "Lab")).status).toBe(200);
  expect((await decide(question, "answer", "Meeting")).status).toBe(409);
  expect(await (await api("agent/inbox-counts")).json()).toEqual({ unread: 1, needsAction: 0 });
  expect(await (await api("agent/inbox?view=updates")).json()).toMatchObject({
    items: [{ id: notice.id }],
    needsAction: 0,
  });
});
it("derives general policy from actual changes and trusted turn origin and replays receipts once", async () => {
  const { api, owner, connect } = fixture();
  const client = await connect();
  const tool = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content[0] as { text: string }).text) as InboxItem;
  };
  try {
    const rules = ["local-create", "local-edit"].map((effect) => ({
      effect,
      origin: "chat",
      mode: "allow",
    }));
    expect((await api("agent/approval", "PUT", { revision: 0, rules })).status).toBe(200);
    expect((await api("agent/approval", "PUT", { revision: 0, rules: [] })).status).toBe(409);
    setAgentTurn(owner, { submission: "manual", origin: "chat" });
    const args = { requestBody: { id: crypto.randomUUID(), title: "Draft note" } };
    const create = await tool("createTask", args);
    expect(create.status).toBe("applied");
    expect(await tool("createTask", args)).toEqual(create);
    const t = await (await api("tasks/" + args.requestBody.id)).json<{ revision: number }>();
    const other = await tool("createPlannerGoal", {
      requestBody: { id: crypto.randomUUID(), title: "Plan this week" },
    });
    expect(other.status).toBe("applied");
    setAgentTurn(owner, { submission: "cron", origin: "scheduled" });
    const denied = await client.callTool({name:"getTask",arguments:{id:args.requestBody.id}});
    expect(denied.isError).toBe(true);
    setAgentTurn(owner,undefined);
    const proposed = await tool("updateTask", {
      id: args.requestBody.id,
      requestBody: { title: "New title", revision: t.revision },
    });
    expect(proposed.status).toBe("pending");
    expect(proposed.taskTitles).toEqual({ [args.requestBody.id]: "Draft note" });
    expect(proposed.changes).toContainEqual({
      field: "task " + args.requestBody.id + " · title",
      before: "Draft note",
      after: "New title",
    });
    await api("tasks/" + args.requestBody.id, "PATCH", {
      revision: t.revision,
      title: "Edited elsewhere",
    });
    expect(
      (
        await api("agent/inbox/" + proposed.id + "/decision", "POST", {
          decision: "approve",
          version: 1,
        })
      ).status,
    ).toBe(409);
    expect(await (await api("tasks/" + args.requestBody.id)).json()).toMatchObject({
      title: "Edited elsewhere",
    });
    expect((await (await api("agent/inbox/" + proposed.id)).json<InboxItem>()).taskTitles)
      .toEqual({ [args.requestBody.id]: "Draft note" });
  } finally {
    setAgentTurn(owner, undefined);
    await client.close();
  }
});
it("rolls back an entire multi-record diff on conflict and rebases unrelated field edits", async () => {
  const { api, decide } = fixture();
  const create = async (title: string) =>
    (await api("tasks", "POST", { title })).json<{ id: string; revision: number }>();
  const a = await create("First"),
    b = await create("Second");
  const steps = [a, b].map((t) => ({
    operation: "updateTask",
    args: { id: t.id, requestBody: { completed: true, revision: t.revision } },
  }));
  const group = await (
    await api("agent/changes", "POST", {
      id: crypto.randomUUID(),
      title: "Finish work",
      reason: "User requested both changes",
      steps,
    })
  ).json<InboxItem>();
  expect(group.status).toBe("pending");
  expect(group.changes).toHaveLength(2);
  expect(group.taskTitles).toEqual({[a.id]: "First", [b.id]: "Second"});
  await api("tasks/" + b.id, "PATCH", { completed: true, revision: b.revision });
  expect((await decide(group, "approve")).status).toBe(409);
  expect(await (await api("tasks/" + a.id)).json()).toMatchObject({ completed: false });
  const single = await (
    await api("agent/changes", "POST", {
      id: crypto.randomUUID(),
      title: "Finish one",
      reason: "Complete this entry",
      steps: steps.slice(0, 1),
    })
  ).json<InboxItem>();
  await api("tasks/" + a.id, "PATCH", { revision: a.revision, title: "Renamed outside chat" });
  expect(await (await decide(single, "approve")).json()).toMatchObject({ status: "applied" });
  expect(await (await api("tasks/" + a.id)).json()).toMatchObject({
    title: "Renamed outside chat",
    completed: true,
  });
  expect(
    (
      await api("agent/changes", "POST", {
        id: crypto.randomUUID(),
        title: "Configuration",
        reason: "Attempt policy rewrite",
        steps: [
          { operation: "updateApprovalPolicy", args: { requestBody: { revision: 0, rules: [] } } },
        ],
      })
    ).status,
  ).toBe(400);
});

it("applies scoped rules to whole change sets and gives a matching review preference precedence", async () => {
  const { autoApproved, actionScope } = await import("../src/core/agent-approval.ts");
  const scope = actionScope(
    ["updateTask", "writePage"],
    [
      { field: "task alpha · title", before: "A", after: "B" },
      { field: "day_page 2026-11-26 · content", before: [], after: ["B"] },
    ],
  );
  const allow = { effect: "local-edit" as const, mode: "allow" as const, origin: "chat" as const };
  expect(
    autoApproved(
      { revision: 0, rules: [{ ...allow, maxResources: 2, reversibleOnly: true }] },
      ["local-edit"],
      "chat",
      scope,
    ),
  ).toBe(true);
  for (const rule of [
    { ...allow, maxResources: 1 },
    { ...allow, operations: ["writePage"] },
    { ...allow, resourceIds: ["alpha"] },
  ])
    expect(autoApproved({ revision: 1, rules: [rule] }, ["local-edit"], "chat", scope)).toBe(false);
  expect(
    autoApproved(
      { revision: 1, rules: [allow, { ...allow, mode: "ask", resourceIds: ["alpha"] }] },
      ["local-edit"],
      "chat",
      scope,
    ),
  ).toBe(false);
  expect(autoApproved({ revision: 1, rules: [allow] }, ["local-edit"], "scheduled", scope)).toBe(
    false,
  );
});

it("binds time diffs to their calendar destination and waits for provider settlement", async () => {
  const { env, runInDurableObject } = await import("cloudflare:test");
  const f = fixture(),
    stub = (env as unknown as ConnectorEnv).USER_PLANNER.getByName(f.owner);
  const fixed = (hour: number) => ({
    type: "fixed" as const,
    start: `2030-02-14T${hour}:00:00Z`,
    end: `2030-02-14T${hour + 1}:00:00Z`,
  });
  const t = await (
    await f.api("tasks", "POST", { kind: "event", title: "Lab", schedule: fixed(14) })
  ).json<{ revision: number; id: string }>();
  const draft = { taskId: t.id, revision: t.revision, after: fixed(16), reason: "Move the lab" };
  const local = await (
    await f.api("review", "POST", { ...draft, id: crypto.randomUUID() })
  ).json<{ id: string }>();
  await runInDurableObject(stub, async (planner) => {
    expect(await planner.publishCalendar(t.id, "account-A", true)).toBe(true);
  });
  expect(
    (await f.api("review/" + local.id + "/decision", "POST", { decision: "accept" })).status,
  ).toBe(409);
  const linked = await (
    await f.api("review", "POST", { ...draft, id: crypto.randomUUID() })
  ).json<{ id: string }>();
  const item = await (await f.api("agent/inbox/" + linked.id)).json<InboxItem>();
  expect(item.changes).toContainEqual(expect.objectContaining({ field: "Google Calendar event" }));
  expect((await (await f.decide(item, "approve")).json<InboxItem>()).status).toBe("queued");
  await runInDurableObject(stub, async (planner) => {
    const [row] = planner.calendarExports("account-A", "");
    expect(planner.calendarActionReceipt(linked.id)).toBe("awaiting-provider");
    await planner.finishCalendarExport(t.id, row.link.remoteId, row.task, {
      kind: "sync",
      fields: { title: "Lab", schedule: fixed(16) },
      apply: false,
      written: true,
    });
    expect(planner.calendarActionReceipt(linked.id)).toBe("applied");
  });
  expect((await (await f.api("agent/inbox/" + linked.id)).json<InboxItem>()).status).toBe(
    "applied",
  );
});

it("reviews task-driven reminder rescheduling and rejects deleting a subsequently changed reminder", async () => {
  const { api, connect, decide } = fixture();
  const taskId = crypto.randomUUID(),
    ruleId = crypto.randomUUID();
  const when = (hour: number) => ({
    type: "time" as const,
    at: "2033-06-01T" + hour + ":00:00Z",
    timeZone: "UTC",
  });
  const task = await (
    await api("tasks", "POST", { id: taskId, title: "Conference", due: when(12) })
  ).json<{ revision: number }>();
  const rule = {
    enabled: true,
    title: "Conference reminder",
    taskId,
    trigger: { kind: "before", anchor: "due", minutes: 20 },
  };
  expect((await api("reminders/" + ruleId, "PUT", rule)).status).toBe(200);
  const client = await connect();
  async function submit(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content[0] as { text: string }).text) as InboxItem;
  }
  try {
    const move = await submit("updateTask", {
      id: taskId,
      requestBody: { revision: task.revision, due: when(13) },
    });
    expect(move.changes).toContainEqual({
      field: "reminder_slot " + ruleId + " / " + taskId + " · scheduledFor",
      before: Date.parse(when(12).at) - 20 * 60000,
      after: Date.parse(when(13).at) - 20 * 60000,
    });
    const remove = await submit("deleteTask", { id: taskId });
    expect(remove.changes).toContainEqual({
      field: "reminder_rule " + ruleId,
      before: rule,
      after: null,
    });
    expect(
      (await api("reminders/" + ruleId, "PUT", { ...rule, title: "Revised reminder" })).status,
    ).toBe(200);
    const decision = await decide(remove, "approve");
    expect(decision.status).toBe(409);
    expect((await api("tasks/" + taskId)).status).toBe(200);
    expect(await (await api("reminders")).json()).toMatchObject({
      rules: [{ id: ruleId, title: "Revised reminder" }],
    });
  } finally {
    await client.close();
  }
});

it.each(["success", "conflict", "disabled"] as const)(
  "settles a grouped calendar edit after every matching export (%s)",
  async (outcome) => {
    const { runInDurableObject } = await import("cloudflare:test");
    const f = fixture(),
      stub = (env as unknown as ConnectorEnv).USER_PLANNER.getByName(f.owner);
    const schedule = { type: "day" as const, date: "2030-03-11" };
    const create = async (title: string) => {
      const t = await (
        await f.api("tasks", "POST", { kind: "event", title, schedule })
      ).json<{ id: string; revision: number }>();
      await stub.publishCalendar(t.id, "test-subject", true);
      return t;
    };
    const first = await create("First event"),
      last = await create("Second event");
    const candidate = await (
      await f.api("agent/changes", "POST", {
        id: crypto.randomUUID(),
        title: "Rename two events",
        reason: "Use project names",
        steps: [first, last].map((task, i) => ({
          operation: "updateTask",
          args: { id: task.id, requestBody: { revision: task.revision, title: "Project " + i } },
        })),
      })
    ).json<InboxItem>();
    expect(
      candidate.changes.filter((c) => c.field.startsWith("Linked calendar event")),
    ).toHaveLength(2);
    expect(await (await f.decide(candidate, "approve")).json()).toMatchObject({ status: "queued" });
    async function readStatus() {
      return (await (await f.api("agent/inbox/" + candidate.id)).json<InboxItem>()).status;
    }
    async function settle(id: string, kind: "sync" | "conflict", old = false) {
      await runInDurableObject(stub, async (planner) => {
        const row = planner
          .calendarExports("test-subject", "")
          .find((entry) => entry.link.taskId === id)!;
        await planner.finishCalendarExport(
          id,
          row.link.remoteId,
          old ? { ...row.task!, revision: 0 } : row.task,
          kind === "conflict"
            ? { kind }
            : { kind, fields: { title: row.task!.title, schedule }, apply: false, written: true },
        );
      });
    }
    await settle(first.id, "sync", true);
    expect(await readStatus()).toBe("queued");
    await settle(first.id, "sync");
    await settle(first.id, "sync");
    expect(await readStatus()).toBe("queued");
    if (outcome === "disabled") await stub.setCalendarExportEnabled("test-subject", false);
    else await settle(last.id, outcome === "success" ? "sync" : "conflict");
    expect(await readStatus()).toBe(outcome === "success" ? "applied" : "failed");
    await settle(last.id, "sync");
    expect(await readStatus()).toBe(outcome === "success" ? "applied" : "failed");
  },
);

it("withdraws a proposal on a correction and binds its replacement to the original conversation",async()=>{
  const {owner,api,connect,decide}=fixture();
  const client=await connect();
  const task=await (await api("tasks","POST",{title:"Write notes"})).json<{id:string;revision:number}>();
  const send=async(title:string)=>{
    const result=await client.callTool({name:"updateTask",arguments:{id:task.id,requestBody:{title,revision:task.revision}}});
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content[0] as {text:string}).text) as InboxItem;
  };
  try {
    setAgentTurn(owner,{origin:"chat",submission:"original"});
    const old=await send("Write workshop notes");
    const revise={version:old.version,decision:"revise",answer:"Use seminar instead."};
    expect(await (await api("agent/inbox/"+old.id+"/decision","POST",revise)).json()).toMatchObject({status:"revision-requested"});
    expect((await decide(old,"approve")).status).toBe(409);
    setAgentTurn(owner,{origin:"chat",submission:"revision",replaces:old.id});
    const updated=await send("Write seminar notes");
    expect(updated).toMatchObject({replaces:old.id,version:old.version+1,status:"pending"});
    expect(await (await api("agent/inbox/"+old.id)).json()).toMatchObject({replacementId:updated.id});
    expect((await decide(updated,"approve")).status).toBe(200);
    expect(await (await api("tasks/"+task.id)).json()).toMatchObject({title:"Write seminar notes"});
  } finally {setAgentTurn(owner,undefined);await client.close();}
});

it("invalidates the canonical time proposal when approval becomes stale", async()=>{
  const {api}=fixture();
  const before={type:"fixed",start:"2026-11-29T12:00:00Z",end:"2026-11-29T13:00:00Z"};
  const after={type:"fixed",start:"2026-11-29T14:00:00Z",end:"2026-11-29T15:00:00Z"};
  const original=await (await api("tasks","POST",{title:"Appointment",kind:"event",schedule:before})).json<{id:string;revision:number}>();
  const input={id:crypto.randomUUID(),taskId:original.id,revision:original.revision,after,reason:"Move"};
  await api("review","POST",input);
  const changed=await (await api("tasks/"+original.id,"PATCH",{revision:original.revision,completed:true})).json<{revision:number}>();
  expect((await api("agent/inbox/"+input.id+"/decision","POST",{version:1,decision:"approve"})).status).toBe(409);
  expect(await (await api("review")).json()).toEqual([]);
  const reopened=await (await api("tasks/"+original.id,"PATCH",{revision:changed.revision,completed:false})).json<{revision:number}>();
  expect((await api("review/"+input.id+"/decision","POST",{decision:"accept"})).status).toBe(409);
  const next=crypto.randomUUID();
  expect(await (await api("review","POST",{...input,id:next,revision:reopened.revision})).json()).toMatchObject({id:next,status:"pending"});
});

it("lets a signed-in chat propose a scheduled routine and binds it on human approval",async()=>{
  const {owner,api,connect,decide}=fixture();
  const client=await connect();
  try {
    setAgentTurn(owner,{origin:"chat",submission:"routine-setup"});
    const id=crypto.randomUUID(), rule={title:"Daily plan",enabled:true,trigger:{kind:"routine",time:"09:00",instruction:"Review my pending tasks."}};
    const result=await client.callTool({name:"setReminder",arguments:{id,requestBody:rule}});
    expect(result.isError).toBeFalsy();
    const pending=JSON.parse((result.content[0] as {text:string}).text) as InboxItem;
    expect(pending.status).toBe("pending");
    expect((await decide(pending,"approve")).status).toBe(200);
    expect(await (await api("reminders")).json()).toMatchObject({rules:[{id,...rule}]});
  } finally {setAgentTurn(owner,undefined);await client.close();}
});

it("places chat todos on the message's local day in single and grouped proposals", async () => {
  const {owner, api, decide, connect} = fixture();
  const client = await connect();
  const calendar = {date: "2026-03-07", timeZone: "America/Toronto"};
  const task = {id: crypto.randomUUID(), title: "Pack display samples"};
  const group = [
    {id: crypto.randomUUID(), title: "Book a room"},
    {id: crypto.randomUUID(), title: "Backlog idea", schedule: null},
    {id: crypto.randomUUID(), title: "Visit the print shop", schedule: {type: "day", date: "2026-03-09"}},
    {id: crypto.randomUUID(), title: "Payment deadline", due: {type: "day", date: "2026-03-12"}},
    {id: crypto.randomUUID(), title: "Workshop", kind: "event", schedule: {type: "fixed", start:"2026-03-12T10:00:00-04:00",end:"2026-03-12T11:00:00-04:00"}},
  ];
  async function propose(name: string, requestBody: object) {
    const result = await client.callTool({name, arguments: {requestBody}});
    expect(result.isError).toBeFalsy();
    return JSON.parse((result.content[0] as {text:string}).text) as InboxItem;
  }
  try {
    setAgentTurn(owner, {submission:"capture", origin:"chat", calendar});
    const one = await propose("createTask", task);
    const many = await propose("proposeChanges", {
      id: crypto.randomUUID(), title:"Capture tasks", reason:"Requested list",
      steps: group.map(requestBody => ({operation:"createTask", args:{requestBody}})),
    });
    expect(one.changes).toContainEqual(expect.objectContaining({after:expect.objectContaining({id:task.id,currentDay:calendar.date})}));
    setAgentTurn(owner, undefined);
    expect((await decide(one,"approve")).status).toBe(200);
    expect((await decide(many,"approve")).status).toBe(200);
    const saved = async (id:string) => (await api("tasks/"+id)).json();
    for (const t of [task, group[0]]) {
      expect(await saved(t.id)).toMatchObject({createdDate:calendar.date, currentDay:calendar.date, schedule:{type:"day",date:calendar.date}});
    }
    expect(await saved(group[1].id)).toMatchObject({currentDay:null, schedule:null});
    expect(await saved(group[2].id)).toMatchObject({currentDay:"2026-03-09",schedule:group[2].schedule});
    expect(await saved(group[3].id)).toMatchObject({currentDay:null, schedule:null, due:group[3].due});
    expect(await saved(group[4].id)).toMatchObject({currentDay:"2026-03-12",schedule:group[4].schedule});
  } finally {
    setAgentTurn(owner, undefined);
    await client.close();
  }
});
