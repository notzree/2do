import type { EventFields } from "../interfaces/connectors.ts";
import { sameFields, type ExportResult } from "./calendar-sync.ts";

type State = "awaiting-provider" | "applied" | "failed";
export type CalendarExpectation = {
  revision?: number;
  detach?: boolean;
  taskId: string;
  account: string;
  remoteId: string;
  expected: EventFields | null;
};
type Pending = CalendarExpectation & { receiptId: string };
const remainingPrefix = "agent-calendar:remaining:";
const pendingPrefix = "agent-calendar:pending:";
const outcomePrefix = "agent-calendar:outcome:";

// Calendar and inbox share this planner. Store the receipt alongside the link or deletion
// reservation before returning admission to the connector. The provider callback can arrive first.
export class AgentCalendarReceipts {
  constructor(
    private kv: DurableObjectStorage["kv"],
    private settle: (id: string, success: boolean, reason?: string) => void,
  ) {}
  state(id: string) {
    return this.kv.get<State>(outcomePrefix + id) ?? null;
  }
  remember(entry: Pending) {
    const key = pendingPrefix + entry.remoteId + ":" + entry.receiptId;
    if (!this.kv.get(key)) {
      const remainingKey = remainingPrefix + entry.receiptId;
      this.kv.put(remainingKey, (this.kv.get<number>(remainingKey) ?? 0) + 1);
    }
    this.kv.put(key, entry);
    this.kv.put(outcomePrefix + entry.receiptId, "awaiting-provider");
  }
  private finish(key: string, p: Pending, ok: boolean, reason?: string) {
    this.kv.delete(key);
    const remainingKey = remainingPrefix + p.receiptId;
    const remaining = (this.kv.get<number>(remainingKey) ?? 1) - 1;
    if (remaining > 0) this.kv.put(remainingKey, remaining);
    else this.kv.delete(remainingKey);
    if (this.state(p.receiptId) === "failed" || (ok && remaining > 0)) return;
    this.kv.put(outcomePrefix + p.receiptId, ok ? "applied" : "failed");
    this.settle(p.receiptId, ok, reason);
  }
  resolve(
    taskId: string,
    remoteId: string,
    account: string,
    result: ExportResult,
    conflict: boolean,
    scanRevision?: number,
  ) {
    for (const [key, p] of this.kv.list<Pending>({ prefix: pendingPrefix + remoteId + ":" })) {
      if (p.taskId !== taskId || p.account !== account) continue;
      if (p.revision !== undefined && scanRevision !== undefined && scanRevision < p.revision)
        continue;
      const ok = p.expected
        ? result.kind === "sync" && !conflict && sameFields(p.expected, result.fields)
        : p.detach
          ? result.kind === "detach"
          : result.kind === "deleted";
      this.finish(
        key,
        p,
        ok,
        ok ? undefined : "Calendar sync could not apply the reviewed change.",
      );
    }
  }
  cancel(account?: string, remoteId?: string) {
    for (const [key, p] of this.kv.list<Pending>({
      prefix: pendingPrefix + (remoteId ? remoteId + ":" : ""),
    })) {
      if (!account || p.account === account)
        this.finish(key, p, false, "Calendar sync was canceled before the change was confirmed.");
    }
  }
}
