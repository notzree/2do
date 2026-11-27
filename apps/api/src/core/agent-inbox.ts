import { validateElicitationReply, type ElicitationReply } from "../interfaces/elicitation.ts";
import type { ElicitationRound } from "../mcp/elicitation-client.ts";
import { and, asc, desc, eq, inArray, lt, lte, min, sql } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { inboxRows, type InboxCommand, type InboxDocument } from "../db/schema.ts";
import type { PlannerStore } from "../db/planner.ts";
import type {
  ApprovalPolicy,
  InboxChange,
  InboxDecision,
  InboxEffect,
  InboxItem,
  InboxPage,
  GroupedChanges,
} from "../interfaces/agent-inbox.ts";
import { PlannerError } from "./planner.ts";
import type { CommitTaskWrite } from "../interfaces/database.ts";
import type { Review } from "./review.ts";
import { autoApproved, actionScope } from "./agent-approval.ts";

import type { CalendarExpectation } from "./agent-calendar-receipts.ts";
type Row = typeof inboxRows.$inferSelect;
export type AgentContext = {
  calendar?: import("../agents/chat-calendar.ts").ChatCalendar;
  conversation?: string;
  replaces?: string;
  submission?: string;
  origin?: "chat" | "scheduled";
};
export type Execution = {
  taskTitles?: Record<string, string>;
  changes: InboxChange[];
  effects: InboxEffect[];
  calendars?: CalendarExpectation[];
  review?: boolean;
};
type Hooks = {
  transaction: <T>(write: () => Promise<T>) => Promise<T>;
  run: (command: InboxCommand, preview: boolean) => Promise<Execution>;
  trackCalendar: (id: string, expectations: CalendarExpectation[]) => void;
  deliver: (row: Row) => Promise<void | "awaiting-provider" | "applied">;
  group: (input: GroupedChanges, context: AgentContext) => Promise<InboxItem>;
};
const policyKey = "agent:approval-policy";
const pending = eq(inboxRows.status, "pending");

export function publicInboxItem(row: Row): InboxItem {
  const {
    conversation,
    command: _command,
    authorization: _auth,
    continuation: _continuation,
    providerAnswer: _providerAnswer,
    ...doc
  } = row.document;
  const publicChat = conversation?.startsWith("side:")
    ? conversation.split(":")[1]
    : conversation && !conversation.startsWith("routine:")
      ? "me"
      : undefined;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    version: row.version,
    read: row.read,
    archived: row.archived,
    createdAt: row.createdAt,
    choices: [],
    changes: [],
    ...doc,
    ...(publicChat && { conversation: publicChat }),
  };
}
export class AgentInbox {
  constructor(
    private db: PlannerStore,
    private storage: DurableObjectStorage,
    private review: Review,
    private hooks: Hooks,
  ) {}
  group(input: GroupedChanges, context: AgentContext) {
    return this.hooks.group(input, context);
  }
  private row(id: string) {
    return this.db.select().from(inboxRows).where(eq(inboxRows.id, id)).get();
  }
  private required(id: string) {
    const row = this.row(id);
    if (!row) throw new PlannerError(404, "Inbox item not found.");
    return row;
  }
  published(id: string) {
    const row = this.row(id);
    return row ? publicInboxItem(row) : undefined;
  }
  get(id: string) {
    return publicInboxItem(this.required(id));
  }
  getMany(ids: string[]) {
    return this.db.select().from(inboxRows).where(inArray(inboxRows.id, ids)).all().map(publicInboxItem);
  }
  counts() {
    return this.db.select({
      unread: sql<number>`count(*) filter (where ${eq(inboxRows.read, false)})`,
      needsAction: sql<number>`count(*) filter (where ${pending})`,
    }).from(inboxRows).where(eq(inboxRows.archived, false)).get()!;
  }
  list({
    view,
    cursor,
    limit, chat, kind, q,
  }: {
    view: "all" | "action" | "updates";
    cursor?: string;
    limit: number; chat?: string; kind?: InboxItem["kind"]; q?: string;
  }): InboxPage {
    const visible = eq(inboxRows.archived, false);
    const rows = this.db
      .select()
      .from(inboxRows)
      .where(
        and(
          visible,
          kind ? eq(inboxRows.kind, kind) : undefined,
          q ? sql`instr(lower(coalesce(json_extract(${inboxRows.document}, '$.title'),'') || ' ' || coalesce(json_extract(${inboxRows.document}, '$.body'),'') || ' ' || coalesce(json_extract(${inboxRows.document}, '$.changes'),'')), lower(${q})) > 0` : undefined,
          chat ? sql`(CASE WHEN json_extract(${inboxRows.document}, '$.conversation') LIKE 'side:%' THEN substr(json_extract(${inboxRows.document}, '$.conversation'),6,36) ELSE 'me' END = ${chat}
            OR EXISTS(SELECT 1 FROM agent_item_link l WHERE l.item = ${inboxRows.id} AND l.chat = ${chat}))` : undefined,
          view === "action" ? pending : undefined,
          view === "updates" ? eq(inboxRows.kind, "notification") : undefined,
          cursor ? lt(inboxRows.sequence, Number(cursor)) : undefined,
        ),
      )
      .orderBy(desc(inboxRows.sequence))
      .limit(limit + 1)
      .all();
    return {
      items: rows.slice(0, limit).map(row => ({ ...publicInboxItem(row), ...(chat && {references:[chat]}) })),
      nextCursor: rows.length > limit ? String(rows[limit - 1].sequence) : null,
      ...this.counts(),
    };
  }
  private replacementVersion(id: string, doc: InboxDocument) {
    if (!doc.replaces) return 1;
    const old = this.required(doc.replaces);
    if (
      old.kind !== "proposal" ||
      old.document.conversation !== doc.conversation ||
      old.status !== "revision-requested" ||
      (old.document.replacementId && old.document.replacementId !== id)
    )
      throw new PlannerError(409, "This proposal has already been replaced or resolved.");
    this.db
      .update(inboxRows)
      .set({ document: { ...old.document, replacementId: id } })
      .where(eq(inboxRows.id, old.id))
      .run();
    return old.version + 1;
  }

  private insert(
    id: string,
    kind: Row["kind"],
    status: Row["status"],
    document: InboxDocument,
    read = false,
  ) {
    const old = this.row(id);
    if (old) return old;
    return this.db
      .insert(inboxRows)
      .values({
        id,
        kind,
        status,
        version: this.replacementVersion(id, document),
        document,
        read,
        due: status === "pending" && document.expiresAt ? Date.parse(document.expiresAt) : null,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();
  }
  ask(
    input: {
      id: string;
      title: string;
      body: string;
      taskId?: string;
      choices?: string[];
      expiresAt?: string;
    },
    conversation?: string,
  ) {
    return this.hooks.transaction(async () => this.publish("question", input, conversation));
  }
  attachReview(id: string, conversation: string, replaces?: string) {
    const old = this.row(id);
    if (
      !old ||
      old.document.source !== "review" ||
      old.status !== "pending" ||
      old.document.conversation
    )
      return;
    this.db
      .update(inboxRows)
      .set({
        document: { ...old.document, conversation, replaces },
        version: this.replacementVersion(id, { ...old.document, conversation, replaces }),
      })
      .where(eq(inboxRows.id, id))
      .run();
  }
  publish(
    kind: "question" | "notification",
    input: {
      id: string;
      title: string;
      body: string;
      taskId?: string;
      reminderId?: string;
      choices?: string[];
      expiresAt?: string;
    },
    conversation?: string,
  ) {
    const { id, ...content } = input;
    const doc = { ...content, conversation };
    const existing = this.row(id);
    if (!existing && input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new HTTPException(400, { message: "Choose a future expiration." });
    if (
      existing &&
      (existing.kind !== kind ||
        existing.document.title !== doc.title ||
        existing.document.body !== doc.body ||
        existing.document.expiresAt !== doc.expiresAt ||
        existing.document.taskId !== doc.taskId ||
        existing.document.conversation !== conversation ||
        JSON.stringify(existing.document.choices ?? []) !== JSON.stringify(input.choices ?? []))
    )
      throw new PlannerError(409, "That publication ID already refers to a different item.");
    return publicInboxItem(
      this.insert(id, kind, kind === "question" ? "pending" : "published", doc),
    );
  }
  elicitationQuestion(
    result: Extract<ElicitationRound, { kind: "question" }>,
    conversation?: string,
  ) {
    const { view, continuation } = result;
    const id = "mcp-" + continuation.workflow + "-" + continuation.round;
    return publicInboxItem(
      this.insert(id, "question", "pending", {
        title: view.provider,
        body: view.message,
        source: "connector input",
        conversation,
        elicitation: view,
        continuation,
        expiresAt: new Date(Date.now() + 24 * 3600_000).toISOString(),
      }),
    );
  }
  failElicitation(id: string, reason: string) {
    const row = this.required(id);
    if (row.status !== "queued" || !row.document.continuation) return;
    this.db
      .update(inboxRows)
      .set({
        status: "failed",
        document: { ...row.document, body: reason },
        due: row.document.conversation ? Date.now() : null,
      })
      .where(eq(inboxRows.id, id))
      .run();
  }
  finishElicitation(id: string, result: ElicitationRound) {
    const row = this.required(id);
    if (row.status !== "queued" || !row.document.continuation) return;
    const next = result.kind === "question";
    const nextItemId = next ? this.elicitationQuestion(result,row.document.conversation).id : undefined;
    const doc = { ...row.document, nextItemId, answer: next ? "Continued to the next question." : result.text };
    this.db
      .update(inboxRows)
      .set({
        status: "answered",
        document: doc,
        due: !next && doc.conversation ? Date.now() : null,
        attempts: 0,
      })
      .where(eq(inboxRows.id, id))
      .run();
  }
  mark(id: string, patch: { read?: boolean; archived?: boolean }) {
    const old = this.required(id);
    if (patch.archived && old.status === "pending")
      throw new PlannerError(409, "Resolve this item before archiving it.");
    const row = this.db.update(inboxRows).set(patch).where(eq(inboxRows.id, id)).returning().get();
    return publicInboxItem(row);
  }
  policy(): ApprovalPolicy {
    return this.storage.kv.get<ApprovalPolicy>(policyKey) ?? { revision: 0, rules: [] };
  }
  configure(input: ApprovalPolicy) {
    const previous = this.policy();
    if (JSON.stringify(input.rules) === JSON.stringify(previous.rules)) return previous;
    if (input.revision !== previous.revision)
      throw new PlannerError(409, "Approval settings changed. Reload before saving.");
    const next = { rules: input.rules, revision: input.revision + 1 };
    this.storage.kv.put(policyKey, next);
    return next;
  }
  async request(
    id: string,
    command: InboxCommand,
    ctx: AgentContext,
    description?: { title: string; body: string; source?: string; expiresAt?: string },
  ) {
    const existing = this.row(id);
    if (existing) {
      if (
        command.steps &&
        (JSON.stringify(existing.document.command?.steps) !== JSON.stringify(command.steps) ||
          existing.document.title !== description?.title ||
          existing.document.body !== description?.body ||
          existing.document.expiresAt !== description?.expiresAt)
      )
        throw new PlannerError(409, "This group ID already belongs to another change.");
      return publicInboxItem(existing);
    }
    if (description?.expiresAt && Date.parse(description.expiresAt) <= Date.now())
      throw new HTTPException(400, { message: "Choose a future expiration." });
    const preview = await this.hooks.run(command, true);
    const effects = preview.effects;
    return this.hooks.transaction(async () => {
      const replay = this.row(id);
      if (replay) return publicInboxItem(replay);
      const auto =
        !ctx.replaces &&
        !preview.review &&
        preview.changes.length > 0 &&
        ctx.submission &&
        ctx.conversation &&
        autoApproved(
          this.policy(),
          effects,
          ctx.origin,
          actionScope(
            command.steps?.map((step) => step.operation) ?? [command.operation],
            preview.changes,
          ),
        );
      const doc: InboxDocument = {
        ...description,
        title:
          description?.title ??
          command.operation.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()),
        body: description?.body ?? "Requested planner changes",
        conversation: ctx.conversation,
        replaces: ctx.replaces,
        changes: preview.changes,
        ...(preview.taskTitles && { taskTitles: preview.taskTitles }),
        command: { ...command, effects },
        authorization: auto ? "policy " + this.policy().revision : undefined,
      };
      const waiting = auto && (await this.apply(id, doc));
      return publicInboxItem(
        this.insert(
          id,
          "proposal",
          auto ? (waiting ? "queued" : "applied") : "pending",
          doc,
          !!auto,
        ),
      );
    });
  }
  async external(
    input: {
      id: string;
      operation: string;
      args: Record<string, unknown>;
      title: string;
      changes: InboxChange[];
    } & AgentContext,
  ) {
    const id = "connector-" + input.id;
    const command: InboxCommand = {
      operation: input.operation,
      args: input.args,
      effects: ["external"],
    };
    const existing = this.row(id);
    if (existing && JSON.stringify(existing.document.command) !== JSON.stringify(command))
      throw new PlannerError(409, "A different connector action already used this ID.");
    return this.hooks.transaction(async () => {
      const auto =
        !input.replaces &&
        !!input.conversation &&
        !!input.submission &&
        input.changes.length > 0 &&
        autoApproved(this.policy(), ["external"], input.origin, {
          operations: [input.operation],
          resourceIds: [
            String((input.args.action as { taskId?: string })?.taskId ?? input.args.kind),
          ],
          account: String(input.args.account),
          reversible: false,
        });
      const row = this.insert(
        id,
        "proposal",
        auto ? "queued" : "pending",
        {
          title: input.title,
          body: "Change the connected account",
          changes: input.changes,
          conversation: input.conversation,
          replaces: input.replaces,
          command,
          source: "connector",
          authorization: auto ? "policy " + this.policy().revision : undefined,
        },
        auto,
      );
      if (auto && row.status === "queued" && row.due === null)
        this.db.update(inboxRows).set({ due: Date.now() }).where(eq(inboxRows.id, id)).run();
      return publicInboxItem(row);
    });
  }
  private async apply(id: string, doc: InboxDocument) {
    const command = doc.command!;
    const actual = await this.hooks.run(command, false);
    if (
      JSON.stringify(actual.changes) !== JSON.stringify(doc.changes) ||
      JSON.stringify(actual.effects) !== JSON.stringify(command.effects)
    )
      throw new PlannerError(409, "This change has new effects. Request an updated proposal.");
    const calendars = actual.calendars ?? [];
    this.hooks.trackCalendar(id, calendars);
    return calendars.length > 0;
  }
  devicePreview(id:string, conversation:string, input:{toolCallId:string;label:string;changes?:InboxChange[];status:string}){
    let row=this.row(id);
    if(input.status==="preview"){
      if(!input.changes?.length)throw new PlannerError(400,"Missing preview.");
      if(!row)row=this.insert(id,"proposal","pending",{source:"device",conversation,title:input.label,body:"Review this change in the browser tab where you requested it.",deviceCallId:input.toolCallId,changes:input.changes});
      if(JSON.stringify(input.changes)!==JSON.stringify(row.document.changes))throw new PlannerError(409,"The device preview changed.");
      if(row.status==="pending")this.db.update(inboxRows).set({due:Date.now()+30*60_000}).where(eq(inboxRows.id,id)).run();
      return id;
    }
    if(!row){
      if(input.status==="authorize")throw new PlannerError(409,"The preview must be registered first.");
      return;
    }
    if(input.status==="authorize"){
      if(row.status!=="pending" && row.status!=="queued")throw new PlannerError(409,"This preview is already resolved.");
      this.db.update(inboxRows).set({status:"queued",read:true,due:Date.now()+5*60_000,document:{...row.document,authorization:"human"}}).where(eq(inboxRows.id,id)).run();
      return id;
    }
    const status=input.status==="applied"?"applied":input.status==="rejected"?"rejected":"failed";
    if(row.status===status)return id;
    if(status==="applied" && row.document.authorization!=="human")throw new PlannerError(409,"Review the preview before applying it.");
    if(!["pending","queued","stale"].includes(row.status) && !(row.status==="failed"&&row.document.authorization==="human"))
      throw new PlannerError(409,"This device outcome is already recorded.");
    this.db.update(inboxRows).set({status,read:true,due:null,document:{...row.document,answer:input.label}}).where(eq(inboxRows.id,id)).run();
    return id;
  }
  async decide(id: string, input: InboxDecision, ownerConversation?: string) {
    try {
      return await this.hooks.transaction(async () => {
        const row = this.required(id);
        if (row.version !== input.version)
          throw new PlannerError(409, "This item changed. Reopen it before deciding.");
        const doc = { ...row.document };
        if(doc.source==="device")throw new PlannerError(403,"Review this preview in the originating browser tab.");
        if (input.decision === "revise") {
          if (row.kind !== "proposal" || !input.answer)
            throw new HTTPException(400, { message: "Describe your requested change." });
          if (row.status === "revision-requested" && doc.answer === input.answer)
            return publicInboxItem(row);
          if (row.status !== "pending")
            throw new PlannerError(409, "This proposal has already been decided.");
          doc.conversation ??= ownerConversation;
          if (!doc.conversation)
            throw new PlannerError(409, "Open a conversation to request changes.");
          if (doc.source === "review") this.review.decide(id, "reject");
          doc.answer = input.answer;
          return publicInboxItem(
            this.db
              .update(inboxRows)
              .set({ status: "revision-requested", read: true, document: doc, due: Date.now() })
              .where(eq(inboxRows.id, id))
              .returning()
              .get(),
          );
        }
        if (doc.elicitation) {
          if (input.decision !== "answer" || !input.elicitation || input.answer !== undefined)
            throw new HTTPException(400, {
              message: "Respond through this connector's form or consent card.",
            });
          let reply: ElicitationReply;
          try {
            reply = validateElicitationReply(doc.elicitation, input.elicitation);
          } catch (error) {
            throw new HTTPException(400, {
              message: error instanceof Error ? error.message : "Invalid connector response.",
            });
          }
          if (row.status !== "pending") {
            if (doc.providerAnswer && JSON.stringify(reply) === JSON.stringify(doc.providerAnswer))
              return publicInboxItem(row);
            throw new PlannerError(409, "This connector question is already resolved.");
          }
          if (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now())
            throw new PlannerError(409, "This question expired.");
          return publicInboxItem(
            this.db
              .update(inboxRows)
              .set({
                read: true,
                status: "queued",
                due: Date.now(),
                document: { ...doc, providerAnswer: reply },
              })
              .where(eq(inboxRows.id, id))
              .returning()
              .get(),
          );
        }
        if (input.elicitation)
          throw new HTTPException(400, { message: "This item does not request connector input." });
        let status: InboxItem["status"] =
          input.decision === "approve"
            ? doc.source === "connector"
              ? "queued"
              : "applied"
            : input.decision === "answer"
              ? "answered"
              : "rejected";
        if (
          row.status === status ||
          (input.decision === "approve" && ["queued", "applied", "failed"].includes(row.status))
        ) {
          if (status === "answered" && doc.answer !== input.answer)
            throw new PlannerError(409, "This question already has a different answer.");
          return publicInboxItem(row);
        }
        if (row.status !== "pending") throw new PlannerError(409, "This item is already resolved.");
        if (doc.expiresAt && Date.parse(doc.expiresAt) <= Date.now())
          throw new PlannerError(409, "This item expired.");
        if (input.decision === "answer" && (row.kind !== "question" || !input.answer))
          throw new HTTPException(400, { message: "Provide an answer to a pending question." });
        if (input.decision === "approve" && row.kind !== "proposal")
          throw new HTTPException(400, { message: "Only a proposal can be approved." });
        if (doc.source === "review") {
          this.review.decide(id, input.decision === "approve" ? "accept" : "reject");
          if (this.row(id)?.status === "queued") status = "queued";
        } else if (
          input.decision === "approve" &&
          doc.source !== "connector" &&
          (await this.apply(id, doc))
        )
          status = "queued";
        if (input.answer) doc.answer = input.answer;
        doc.authorization = "human";
        const due =
          doc.source !== "connector" && status === "queued"
            ? null
            : doc.conversation || status === "queued"
              ? Date.now()
              : null;
        const updated = this.db
          .update(inboxRows)
          .set({ status, document: doc, read: true, due })
          .where(eq(inboxRows.id, id))
          .returning()
          .get();
        return publicInboxItem(updated);
      });
    } catch (error) {
      if (
        input.decision === "approve" &&
        (error instanceof PlannerError || error instanceof HTTPException) &&
        (error.status === 409 || error.status === 404)
      ) {
        await this.hooks.transaction(async () => this.markStale(id, input.version));
      }
      throw error;
    }
  }
  markStale(id: string, version?: number) {
    const row = this.row(id);
    // Old Review aliases have no independent inbox row. The canonical
    // proposal's status trigger schedules the original chat outcome.
    if (version === undefined || row?.version === version) this.review.invalidate(id);
    if (
      row?.kind === "proposal" &&
      row.status === "pending" &&
      (version === undefined || row.version === version)
    )
      this.db
        .update(inboxRows)
        .set({ status: "stale", due: row.document.conversation ? Date.now() : null })
        .where(eq(inboxRows.id, id))
        .run();
  }
  settleProvider(id: string, success: boolean, reason?: string) {
    const row = this.row(id);
    if (row?.status !== "queued") return;
    this.db
      .update(inboxRows)
      .set({
        status: success ? "applied" : "failed",
        due: row.document.conversation ? Date.now() : null,
        attempts: 0,
        document: reason ? { ...row.document, body: reason } : row.document,
      })
      .where(eq(inboxRows.id, id))
      .run();
  }
  nextDue() {
    return (
      this.db
        .select({ time: min(inboxRows.due) })
        .from(inboxRows)
        .get()?.time ?? null
    );
  }
  async processDue(commit: CommitTaskWrite) {
    const rows = this.db
      .select()
      .from(inboxRows)
      .where(lte(inboxRows.due, Date.now()))
      .orderBy(asc(inboxRows.due))
      .limit(8)
      .all();
    for (const row of rows) {
      if(row.document.source==="device"){
        await commit(()=>this.db.update(inboxRows).set({status:row.status==="queued"?"failed":"stale",due:null,document:{...row.document,answer:"The device preview is unavailable. Check the original tab before requesting it again."}}).where(and(eq(inboxRows.id,row.id),eq(inboxRows.status,row.status),lte(inboxRows.due,Date.now()))).run());
        continue;
      }
      if (row.status === "pending") {
        await commit(() =>
          this.db
            .update(inboxRows)
            .set({ status: "stale", due: row.document.conversation ? Date.now() : null })
            .where(and(eq(inboxRows.id, row.id), pending, lte(inboxRows.due, Date.now())))
            .run(),
        );
        continue;
      }
      const lease = Date.now() + 60_000;
      const claimed = await commit(() =>
        this.db
          .update(inboxRows)
          .set({ due: lease })
          .where(and(eq(inboxRows.id, row.id), eq(inboxRows.due, row.due!)))
          .returning()
          .get(),
      );
      if (!claimed) continue;
      try {
        const outcome = await this.hooks.deliver(claimed);
        const applied = claimed.status === "queued" && outcome !== "awaiting-provider";
        await commit(() =>
          this.db
            .update(inboxRows)
            .set({
              status: applied ? "applied" : claimed.status,
              due: applied && claimed.document.conversation ? Date.now() : null,
              attempts: 0,
            })
            .where(
              and(
                eq(inboxRows.id, row.id),
                eq(inboxRows.status, claimed.status),
                eq(inboxRows.due, lease),
              ),
            )
            .run(),
        );
      } catch (error) {
        const attempts = claimed.attempts + 1;
        const failed = attempts >= 8 && claimed.status === "queued";
        await commit(() =>
          this.db
            .update(inboxRows)
            .set({
              attempts,
              status: failed ? "failed" : claimed.status,
              due: failed
                ? claimed.document.conversation
                  ? Date.now()
                  : null
                : Date.now() + Math.min(3600_000, 1000 * 2 ** Math.min(attempts, 12)),
            })
            .where(
              and(
                eq(inboxRows.id, row.id),
                eq(inboxRows.status, claimed.status),
                eq(inboxRows.due, lease),
              ),
            )
            .run(),
        );
        console.warn(
          "Inbox delivery deferred",
          row.id,
          attempts,
          error instanceof Error ? error.name : "Error",
        );
      }
    }
  }
}
