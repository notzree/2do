import type { z } from "zod";
import type {
  activityQuery,
  branchChat,
  chatScope,
  reportMilestone,
  WorkspaceEvent,
} from "../interfaces/agents-workspace.ts";
import { PlannerError } from "./planner-error.ts";

type EventInput = Pick<WorkspaceEvent, "id" | "chat" | "kind" | "title" | "body"> &
  Partial<WorkspaceEvent>;
export class AgentsWorkspace {
  constructor(readonly sql: SqlStorage) {}

  directoryStats() {
    const rows = this.sql
      .exec<{ id: string; lastActivity: string | null; needsAttention: number }>(`
      WITH pending(chat,item) AS (
        SELECT CASE WHEN json_extract(document,'$.conversation') LIKE 'side:%' THEN substr(json_extract(document,'$.conversation'),6,36) ELSE 'me' END,id FROM agent_inbox WHERE status='pending'
        UNION SELECT l.chat,l.item FROM agent_item_link l JOIN agent_inbox i ON i.id=l.item WHERE i.status='pending'
      ) SELECT s.id,(SELECT max(at) FROM agent_activity e WHERE e.chat=s.id) lastActivity,
        (SELECT count(*) FROM pending p WHERE p.chat=s.id) needsAttention FROM side_chat s`)
      .toArray();
    return new Map(
      rows.map((r) => [
        r.id,
        { lastActivity: r.lastActivity ?? undefined, needsAttention: r.needsAttention },
      ]),
    );
  }
  requireChat(chat: string, writable = false) {
    if (chat === "me") return;
    const row = this.sql
      .exec<{ archivedAt: number | null }>("SELECT archivedAt FROM side_chat WHERE id=?", chat)
      .toArray()[0];
    if (!row) throw new PlannerError(404, "Conversation unavailable.");
    if (writable && row.archivedAt !== null)
      throw new PlannerError(409, "Restore this chat before starting new work.");
  }
  addEvent(e: EventInput) {
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_activity(id,chat,kind,title,body,at,itemId,messageId,relatedChat,generation) VALUES(?,?,?,?,?,?,?,?,?,?)",
      e.id,
      e.chat,
      e.kind,
      e.title,
      e.body,
      e.at ?? new Date().toISOString(),
      e.itemId ?? null,
      e.messageId ?? null,
      e.relatedChat ?? null,
      e.generation ?? null,
    );
  }
  link(chat: string, item: string) {
    this.requireChat(chat);
    const record = this.sql
      .exec<{ title: string }>(
        "SELECT json_extract(document,'$.title') AS title FROM agent_inbox WHERE id=?",
        item,
      )
      .toArray()[0];
    if (!record) throw new PlannerError(404, "Workspace item unavailable.");
    this.sql.exec("INSERT OR IGNORE INTO agent_item_link(chat,item) VALUES(?,?)", chat, item);
    this.addEvent({
      id: "link/" + chat + "/" + item,
      chat,
      kind: "reference",
      title: record.title,
      body: "Linked workspace item",
      itemId: item,
    });
  }
  activity({ chat, event, cursor, limit }: z.infer<typeof activityQuery>) {
    const args: (string | number)[] = [];
    const where: string[] = [];
    if (event) {
      where.push("id=?");
      args.push(event);
    }
    if (chat) {
      where.push("chat=?");
      args.push(chat);
    }
    let watermark = this.sql
      .exec<{ n: number }>("SELECT COALESCE(max(seq),0) n FROM agent_activity")
      .one().n;
    if (cursor) {
      const match = /^(\d+)\|([^|]{1,40})\|(\d+)$/.exec(cursor);
      if (!match) throw new PlannerError(400, "Invalid activity cursor.");
      watermark = Number(match[1]);
      where.push("(at,seq)<(?,?)");
      args.push(match[2], Number(match[3]));
    }
    where.push("seq<=?");
    args.push(watermark, limit + 1);
    const rows = this.sql
      .exec<WorkspaceEvent & { seq: number }>(
        `SELECT *, (SELECT title FROM side_chat sc WHERE sc.id=agent_activity.relatedChat) AS relatedTitle,
        (SELECT json_extract(d.attributes,'$.notebookDay') FROM agent_delivery d WHERE d.id=agent_activity.id OR (substr(agent_activity.id,-7)='/source' AND d.id=substr(agent_activity.id,1,length(agent_activity.id)-7)) LIMIT 1) AS notebookDay,
        (SELECT json_extract(document,'$.deviceCallId') FROM agent_inbox i WHERE i.id=agent_activity.itemId) AS deviceCallId, (SELECT coalesce((SELECT outcome FROM agent_delivery_settlement s WHERE s.report=d.id), CASE WHEN d.receipt IS NULL THEN 'queued' ELSE 'admitted' END) FROM agent_delivery d
        WHERE d.id=agent_activity.id OR d.id=substr(agent_activity.id,1,length(agent_activity.id)-7) AND substr(agent_activity.id,-7)='/source' LIMIT 1) AS deliveryStatus
      FROM agent_activity WHERE ` +
          where.join(" AND ") +
          " ORDER BY at DESC,seq DESC LIMIT ?",
        ...args,
      )
      .toArray();
    const items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? [watermark, last.at, last.seq].join("|") : null,
    };
  }
  enqueue(
    id: string,
    target: string,
    type: string,
    body: string,
    attributes: Record<string, string>,
  ) {
    const encoded = JSON.stringify(attributes);
    const previous = this.sql
      .exec<{ body: string; attributes: string }>(
        "SELECT body,attributes FROM agent_delivery WHERE id=?",
        id,
      )
      .toArray()[0];
    if (previous && (previous.body !== body || previous.attributes !== encoded))
      throw new PlannerError(409, "This occurrence already has a different payload.");
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_delivery(id,target,type,body,attributes,due) VALUES(?,?,?,?,?,?)",
      id,
      target,
      type,
      body,
      encoded,
      Date.now(),
    );
  }
  branch(input: z.infer<typeof branchChat>, generation?: string) {
    const origin = {
        messageId: input.messageId,
        excerpt: input.excerpt,
        ...(generation && { generation }),
      },
      encoded = JSON.stringify(origin);
    const existing = this.sql
      .exec<{ branch: string | null }>("SELECT branch FROM side_chat WHERE id=?", input.id)
      .toArray()[0];
    if (existing && existing.branch !== encoded)
      throw new PlannerError(409, "This conversation ID is already in use.");
    this.sql.exec(
      "INSERT OR IGNORE INTO side_chat(id,title,createdAt,branch) VALUES(?,?,?,?)",
      input.id,
      input.title,
      Date.now(),
      encoded,
    );
    const id = "branch/" + input.id;
    this.enqueue(id, input.id, "branch_context", input.excerpt, {
      source: "me",
      messageId: input.messageId,
    });
    this.addEvent({
      id,
      chat: input.id,
      kind: "branch",
      title: "Started from Main chat",
      body: input.excerpt,
      relatedChat: "me",
      messageId: input.messageId,
      generation,
    });
    this.addEvent({
      id: id + "/source",
      chat: "me",
      kind: "branch",
      title: input.title,
      body: "Continued in side chat",
      relatedChat: input.id,
      messageId: input.messageId,
      generation,
    });
    return { id: input.id };
  }
  milestone(chat: string, data: z.infer<typeof reportMilestone>) {
    this.requireChat(chat);
    if (chat === "me") throw new PlannerError(400, "Choose a side chat to report from.");
    const id = "milestone/" + chat + "/" + data.occurrence;
    if (
      data.notebookDay &&
      !this.sql.exec("SELECT 1 FROM day_page WHERE day=?", data.notebookDay).toArray().length
    )
      throw new PlannerError(404, "This notebook page is unavailable.");
    if (data.itemId) {
      const item = this.sql
        .exec<{ version: number; status: string }>(
          "SELECT version,status FROM agent_inbox WHERE id=?",
          data.itemId,
        )
        .toArray()[0];
      if (!item) throw new PlannerError(404, "Referenced workspace item unavailable.");
      const previous = this.sql
        .exec<{ report: string }>(
          "SELECT report FROM agent_milestone_source WHERE chat=? AND item=? AND version=? AND status=?",
          chat,
          data.itemId,
          item.version,
          item.status,
        )
        .toArray()[0];
      if (previous && previous.report !== id) return { id: previous.report };
      this.sql.exec(
        "INSERT OR IGNORE INTO agent_milestone_source VALUES(?,?,?,?,?)",
        chat,
        data.itemId,
        item.version,
        item.status,
        id,
      );
    }
    this.enqueue(
      id,
      "me",
      "side_milestone",
      JSON.stringify({ headline: data.title, summary: data.body }),
      {
        source: chat,
        report: id,
        ...(data.itemId && { itemId: data.itemId }),
        ...(data.notebookDay && { notebookDay: data.notebookDay }),
      },
    );
    this.addEvent({
      id,
      chat: "me",
      kind: "milestone",
      title: data.title,
      body: data.body,
      relatedChat: chat,
      itemId: data.itemId,
    });
    this.addEvent({
      id: id + "/source",
      chat,
      kind: "milestone",
      title: data.title,
      body: data.body,
      relatedChat: "me",
      itemId: data.itemId,
    });
    return { id };
  }
  grant(chat: string, turn: string, scope: z.infer<typeof chatScope>) {
    const normalized = JSON.stringify([...new Set(scope)].sort());
    for (const source of scope) if (source !== "active-sides") this.requireChat(source);
    const old = this.sql
      .exec<{ scope: string }>(
        "SELECT scope FROM agent_turn_scope WHERE chat=? AND turn=?",
        chat,
        turn,
      )
      .toArray()[0];
    if (old && old.scope !== normalized)
      throw new PlannerError(409, "This submission already has different references.");
    this.sql.exec(
      "INSERT OR IGNORE INTO agent_turn_scope(chat,turn,scope) VALUES(?,?,?)",
      chat,
      turn,
      normalized,
    );
  }
  search(q: string, scope: string[]) {
    const words = q.match(/[\p{L}\p{N}]+/gu)?.slice(0, 12);
    if (!words?.length || !scope.length) return [];
    const explicit = scope.filter((id) => id !== "active-sides");
    const clauses = explicit.length
      ? ["m.chat IN (" + explicit.map(() => "?").join(",") + ")"]
      : [];
    if (scope.includes("active-sides")) clauses.push("s.id IS NOT NULL AND s.archivedAt IS NULL");
    return this.sql
      .exec<{
        chat: string;
        title: string;
        messageId: string;
        generation: string;
        excerpt: string;
        at: string;
      }>(
        `
      SELECT m.chat,coalesce(s.title,'Main chat') title,m.messageId,m.generation,m.at,
      snippet(agent_message_fts,0,'','','…',38) excerpt FROM agent_message_fts
      JOIN agent_message m ON m.rowid=agent_message_fts.rowid LEFT JOIN side_chat s ON s.id=m.chat
      WHERE agent_message_fts MATCH ? AND (${clauses.join(" OR ")}) ORDER BY rank,m.at DESC LIMIT 12`,
        words.map((w) => '"' + w + '"*').join(" AND "),
        ...explicit,
      )
      .toArray();
  }
  searchForTurn(chat: string, turn: string | undefined, q: string, source?: string) {
    const row =
      turn &&
      this.sql
        .exec<{ scope: string }>(
          "SELECT scope FROM agent_turn_scope WHERE chat=? AND turn=?",
          chat,
          turn,
        )
        .toArray()[0];
    if (!row)
      throw new PlannerError(
        403,
        "Select a conversation reference or search scope for this message.",
      );
    const scope = JSON.parse(row.scope) as string[];
    if (source && !scope.includes(source)) {
      if (source === "me" || !scope.includes("active-sides"))
        throw new PlannerError(403, "Conversation outside the selected scope.");
      this.requireChat(source, true);
    }
    return this.search(q, source ? [source] : scope);
  }
}
