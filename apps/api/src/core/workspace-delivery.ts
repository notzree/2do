import type { FlueConversationMessage, FlueConversationSettlement } from "@flue/sdk";
import type { WorkspaceInput } from "../agents/workspace-runtime.ts";
import type { AgentsWorkspace } from "./agents-workspace.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import { PlannerError } from "./planner-error.ts";

type Receipt = { submissionId: string; uid: string; acceptedAt: string };

const retryDelay = (n: number) => Math.min(300_000, 2000 * 2 ** Math.min(n, 8));
type HistoryJob = {
  chat: string;
  generation: string | null;
  beforeCursor: string | null;
  due: number;
  again: number;
  attempts: number;
};
type Delivery = {
  id: string;
  target: string;
  type: string;
  body: string;
  attributes: string;
  attempts: number;
};
export class WorkspaceDelivery {
  constructor(
    private readonly workspace: AgentsWorkspace,
    private readonly storage: DurableObjectStorage,
    private readonly commit: CommitTaskWrite,
    private readonly env: Env,
  ) {}
  private get sql() {
    return this.storage.sql;
  }
  owner() {
    return this.storage.kv.get<string>("agent:routing-owner");
  }
  remember(owner: string) {
    if (this.owner() === owner && this.storage.kv.get("workspace:seeded")) return;
    this.storage.kv.put("agent:routing-owner", owner);
    this.storage.kv.put("workspace:seeded", true);
    this.schedule("me");
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_history_job(chat,due) SELECT id,? FROM side_chat",
      Date.now(),
    );
  }
  schedule(chat: string) {
    this.sql.exec(
      `INSERT INTO agent_history_job(chat,due) VALUES(?,?) ON CONFLICT(chat) DO UPDATE SET
      due=coalesce(min(due,excluded.due),excluded.due),again=1`,
      chat,
      Date.now(),
    );
  }
  nextDue() {
    return this.sql
      .exec<{
        n: number | null;
      }>(`SELECT min(d) n FROM (SELECT min(due) d FROM agent_delivery UNION ALL
      SELECT min(due) FROM agent_history_job UNION ALL SELECT min(due) FROM agent_flight)`)
      .one().n;
  }
  async admit(
    owner: string,
    chat: string,
    input: WorkspaceInput,
    report = false,
  ): Promise<Receipt> {
    const payload = JSON.stringify(input),
      key = input.idempotencyKey;
    const replay = await this.commit(() => {
      const old = this.sql
        .exec<{ payload: string | null; receipt: string | null }>(
          "SELECT payload,receipt FROM agent_flight WHERE chat=? AND key=?",
          chat,
          key,
        )
        .toArray()[0];
      if (old && old.payload !== payload)
        throw new PlannerError(409, "This submission has a different payload.");
      if (old?.receipt) return JSON.parse(old.receipt) as Receipt;
      // Regular turns may coalesce. A report receives its own tool-free response.
      if (
        chat === "me" &&
        this.sql
          .exec(
            "SELECT 1 FROM agent_flight WHERE chat=? AND key<>? AND (report=1 OR ?=1) LIMIT 1",
            chat,
            key,
            Number(report),
          )
          .toArray().length
      )
        throw new PlannerError(409, "Main chat is finishing another submission. Retry shortly.");
      this.sql.exec(
        "INSERT OR IGNORE INTO agent_flight(chat,key,report,payload,due) VALUES(?,?,?,?,?)",
        chat,
        key,
        Number(report),
        payload,
        Date.now() + 30_000,
      );
    });
    if (replay) return replay;
    const { workspaceDispatch } = await import("../agents/workspace-runtime.ts");
    let receipt: Receipt;
    try {
      receipt = await workspaceDispatch(owner, chat, input);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 400 || status === 404 || status === 409)
        await this.commit(() =>
          this.sql.exec(
            "DELETE FROM agent_flight WHERE chat=? AND key=? AND receipt IS NULL",
            chat,
            key,
          ),
        );
      throw error;
    }
    await this.commit(() => {
      this.sql.exec(
        "UPDATE agent_flight SET receipt=?,due=NULL WHERE chat=? AND key=?",
        JSON.stringify(receipt),
        chat,
        key,
      );
      const routine = chat.startsWith("routine:");
      const signal =
        typeof input.message === "object" && input.message.kind === "signal"
          ? input.message.type
          : undefined;
      if (routine || signal === "side_milestone")
        this.workspace.addEvent({
          id: "start/" + chat + "/" + receipt.submissionId,
          chat: routine ? "me" : chat,
          kind: "trigger",
          title: routine ? "Scheduled routine started" : "Main received a milestone",
          body: routine ? "Scheduled automation" : "Side-chat update",
          at: receipt.acceptedAt,
        });
      this.schedule(chat);
    });
    return receipt;
  }
  async process() {
    const owner = this.owner();
    if (!owner) return;
    const now = Date.now();
    const job = this.sql
      .exec<Delivery>("SELECT * FROM agent_delivery WHERE due<=? ORDER BY due LIMIT 1", now)
      .toArray()[0];
    if (job) {
      const token = crypto.randomUUID();
      this.sql.exec(
        "UPDATE agent_delivery SET token=?,due=?,attempts=attempts+1 WHERE id=?",
        token,
        now + 60_000,
        job.id,
      );
      try {
        const receipt = await this.admit(
          owner,
          job.target,
          {
            idempotencyKey: job.id,
            message: {
              kind: "signal",
              type: job.type,
              body: job.body,
              attributes: JSON.parse(job.attributes),
            },
          },
          job.type === "side_milestone",
        );
        this.sql.exec(
          "UPDATE agent_delivery SET receipt=?,due=NULL WHERE id=? AND token=?",
          receipt.submissionId,
          job.id,
          token,
        );
      } catch {
        this.sql.exec(
          "UPDATE agent_delivery SET due=? WHERE id=? AND token=?",
          Date.now() +
            Math.min(job.type === "side_milestone" ? 10_000 : 300_000, retryDelay(job.attempts)),
          job.id,
          token,
        );
      }
    }
    const flight = this.sql
      .exec<{ chat: string; key: string; report: number; payload: string }>(
        "SELECT * FROM agent_flight WHERE due<=? ORDER BY due LIMIT 1",
        now,
      )
      .toArray()[0];
    if (flight) {
      this.sql.exec(
        "UPDATE agent_flight SET due=? WHERE chat=? AND key=?",
        now + 60_000,
        flight.chat,
        flight.key,
      );
      try {
        await this.admit(owner, flight.chat, JSON.parse(flight.payload), !!flight.report);
      } catch {
        /* The original admission key is safe to replay. */
      }
    }
    const history = this.sql
      .exec<HistoryJob>("SELECT * FROM agent_history_job WHERE due<=? ORDER BY due LIMIT 1", now)
      .toArray()[0];
    if (history) await this.project(owner, history);
    await this.commit(() => {});
  }
  async requireMainMessage(id: string, owner?: string) {
    if (!owner) throw new PlannerError(404, "Source conversation unavailable.");
    const { readWorkspaceHistory } = await import("../agents/workspace-runtime.ts");
    let cursor: string | null = null;
    let generation = "original";
    do {
      const response = await readWorkspaceHistory(this.env, owner, "me", cursor);
      if (!response.ok) break;
      const page = await response.json<{
        messages: FlueConversationMessage[];
        before?: string;
        incarnation?: string;
      }>();
      if (page.incarnation) generation = String(page.incarnation);
      if (
        page.messages.some(
          (m) =>
            m.id === id &&
            m.display === "visible" &&
            (m.purpose === "user" || m.purpose === "assistant"),
        )
      )
        return generation;
      if (page.before === cursor) break;
      cursor = page.before ?? null;
    } while (cursor);
    throw new PlannerError(404, "The source message is unavailable.");
  }
  private async project(owner: string, job: HistoryJob) {
    const token = crypto.randomUUID();
    this.sql.exec(
      "UPDATE agent_history_job SET token=?,due=?,again=CASE WHEN beforeCursor IS NULL THEN 0 ELSE again END WHERE chat=?",
      token,
      Date.now() + 60_000,
      job.chat,
    );
    try {
      const { readWorkspaceHistory } = await import("../agents/workspace-runtime.ts");
      const response = await readWorkspaceHistory(this.env, owner, job.chat, job.beforeCursor);
      if (response.status === 404 || response.status === 410) {
        const active = this.sql
          .exec("SELECT 1 FROM agent_flight WHERE chat=? LIMIT 1", job.chat)
          .toArray().length;
        if (response.status === 404)
          this.sql.exec("DELETE FROM agent_message WHERE chat=?", job.chat);
        this.sql.exec(
          "UPDATE agent_history_job SET beforeCursor=NULL,due=CASE WHEN again=1 THEN ? ELSE ? END WHERE chat=? AND token=?",
          Date.now(),
          response.status === 410 || active ? Date.now() + 2000 : null,
          job.chat,
          token,
        );
        return;
      }
      if (!response.ok) throw new Error("History unavailable");
      const page = await response.json<{
        incarnation?: string;
        before?: string;
        messages: FlueConversationMessage[];
        settlements?: FlueConversationSettlement[];
      }>();
      await this.commit(() => {
        if (
          !this.sql
            .exec("SELECT 1 FROM agent_history_job WHERE chat=? AND token=?", job.chat, token)
            .toArray().length
        )
          return;
        const gen = String(page.incarnation ?? job.generation ?? "original");
        if (job.generation && job.generation !== gen)
          this.sql.exec("DELETE FROM agent_message WHERE chat=?", job.chat);
        const isRoutine = job.chat.startsWith("routine:"),
          display = isRoutine ? "me" : job.chat;
        const existing = page.messages.some(
          (m) =>
            !!this.sql
              .exec(
                "SELECT 1 FROM agent_message WHERE chat=? AND generation=? AND messageId=?",
                job.chat,
                gen,
                m.id,
              )
              .toArray().length,
        );
        const settled = new Set(page.settlements?.map((s) => s.submissionId));
        for (const m of page.messages) {
          if (!m.timestamp) continue;
          const finalized = !m.submissionId || !!job.beforeCursor || settled.has(m.submissionId);
          if (
            !isRoutine &&
            m.display === "visible" &&
            (m.purpose === "user" || m.purpose === "assistant") &&
            (m.role === "user" || finalized)
          ) {
            const text = m.parts
              .flatMap((p) => (p.type === "text" ? [p.text] : []))
              .join("\n")
              .replace(/^\[2do turn [^\]]+\]\n/, "")
              .replace(/^\[Planner date [^\]]+\]\n\n/, "")
              .split("\n\n[Planner context:")[0]
              .replace(/\n\n\[Referenced conversations: [^\]]+\]$/, "")
              .trim();
            if (text)
              this.sql.exec(
                "INSERT OR IGNORE INTO agent_message(chat,generation,messageId,text,at) VALUES(?,?,?,?,?)",
                job.chat,
                gen,
                m.id,
                text,
                m.timestamp,
              );
          }
          for (const p of m.parts)
            if (
              p.type === "dynamic-tool" &&
              (p.state === "output-available" || p.state === "output-error")
            ) {
              this.workspace.addEvent({
                id: JSON.stringify([job.chat, gen, m.id, p.toolCallId]),
                chat: display,
                kind: "operation",
                title: p.toolName.replace(/^mcp__.+?__/, "").replace(/([a-z])([A-Z])/g, "$1 $2"),
                body:
                  p.state === "output-error"
                    ? "Failed"
                    : p.toolName === "showWorkspace"
                      ? "Requested on device"
                      : "Completed",
                messageId: m.id,
                generation: gen,
                at: m.timestamp,
              });
            }
        }
        for (const s of page.settlements ?? []) {
          this.sql.exec(
            "INSERT OR IGNORE INTO agent_delivery_settlement(report,outcome) SELECT id,? FROM agent_delivery WHERE target=? AND receipt=?",
            s.outcome,
            job.chat,
            s.submissionId,
          );
          this.sql.exec(
            "DELETE FROM agent_flight WHERE chat=? AND json_extract(receipt,'$.submissionId')=?",
            job.chat,
            s.submissionId,
          );
          if (s.timestamp)
            this.workspace.addEvent({
              id: JSON.stringify([job.chat, gen, s.submissionId]),
              chat: display,
              kind: "run",
              title: isRoutine ? "Scheduled run" : "Assistant run",
              body: s.outcome,
              generation: gen,
              at: s.timestamp,
            });
        }
        if (
          job.chat === "me" &&
          page.settlements?.length &&
          !this.sql.exec("SELECT 1 FROM agent_flight WHERE chat='me' LIMIT 1").toArray().length
        ) {
          this.sql.exec(
            "UPDATE agent_delivery SET due=min(due,?) WHERE type='side_milestone' AND due IS NOT NULL AND receipt IS NULL",
            Date.now(),
          );
        }
        const before = existing && !job.beforeCursor ? null : (page.before ?? null);
        const active = this.sql
          .exec("SELECT 1 FROM agent_flight WHERE chat=? LIMIT 1", job.chat)
          .toArray().length;
        this.sql.exec(
          "UPDATE agent_history_job SET generation=?,beforeCursor=?,attempts=0,due=CASE WHEN again=1 THEN ? ELSE ? END WHERE chat=? AND token=?",
          gen,
          before,
          Date.now(),
          before
            ? Date.now()
            : active
              ? Date.now() + 1500
              : job.again && job.beforeCursor
                ? Date.now()
                : null,
          job.chat,
          token,
        );
      });
    } catch {
      this.sql.exec(
        "UPDATE agent_history_job SET due=?,attempts=attempts+1 WHERE chat=? AND token=?",
        Date.now() + retryDelay(job.attempts),
        job.chat,
        token,
      );
    }
  }
}
