import type { AgentSendResult, FlueClient, FlueConversationMessage } from "@flue/sdk";
import { FlueExecutionError } from "@flue/sdk";
import { plannerScopeHeader } from "@2do/api/notebook";
import type { Preferences } from "./preferences.ts";
import { getVerifiedScope } from "./query.ts";
import {
  executeDeviceCalls,
  incomingDeviceCalls,
  registerDeviceObserver, registerDeviceApproval,
  restoreDeviceReceipt,
  useDeviceReceipts,
  type DeviceCall,
  type DeviceReceipt,
} from "./agent-workspace.ts";
import type { DraftSelection } from "./agent-editor.ts";

type StoredCall = DeviceCall & { receipt?: DeviceReceipt; executing?: boolean; reported?: boolean; previewId?:string };
type Submission = {
  chat: string;
  receipt: AgentSendResult;
  prefs: Preferences;
  originUrl: string;
  calls?: StoredCall[];
};
type Journal = { scope: string; key?: string; entries: Record<string, Submission> };
let journal: Journal | undefined;
let activeTab: Promise<string | undefined> | undefined;
const following = new Map<string, Promise<void>>();
const reporting = new Map<string, Promise<void>>();

// Duplicating a tab copies sessionStorage. Exclusively claim its identity before replaying work.
export function tabIdentity() {
  return (activeTab ??= (async () => {
    if (!navigator.locks) return crypto.randomUUID();
    const nameKey = "2do.agent.tab";
    try {
      let id = sessionStorage.getItem(nameKey) || crypto.randomUUID();
      for (;;) {
        const acquired = Promise.withResolvers<boolean>();
        void navigator.locks
          .request("2do.agent.tab." + id, { ifAvailable: true }, async (lock) => {
            acquired.resolve(Boolean(lock));
            if (lock)
              await new Promise<void>((resolve) => {
                const leave = (event: PageTransitionEvent) => {
                  if (event.persisted) return;
                  window.removeEventListener("pagehide", leave);
                  resolve();
                };
                window.addEventListener("pagehide", leave);
              });
          })
          .catch(acquired.reject);
        if (await acquired.promise) {
          sessionStorage.setItem(nameKey, id);
          return id;
        }
        id = crypto.randomUUID();
      }
    } catch {
      return;
    }
  })());
}
function persist() {
  if (!journal?.key) return;
  const settled = Object.entries(journal.entries).filter(([, entry]) =>
    entry.calls?.every((call) => call.reported),
  );
  for (const [id] of settled.slice(0, -100)) delete journal.entries[id];
  sessionStorage.setItem(journal.key, JSON.stringify(journal.entries));
}
async function openJournal(scope: string): Promise<Journal> {
  const tab = await tabIdentity();
  if (journal?.scope === scope) return journal;
  const key = tab && "2do.agent.delivery." + scope + "." + tab;
  let entries: Journal["entries"] = {};
  if (key) {
    try {
      entries = JSON.parse(sessionStorage.getItem(key) || "{}");
    } catch {
      /* Recover from invalid local state. */
    }
  }
  journal = { scope, key, entries };
  return journal;
}
async function report(scope: string, submission: Submission, call: StoredCall) {
  if (
    getVerifiedScope() !== scope ||
    !call.receipt ||
    call.receipt.status === "waiting" ||
    call.reported
  )
    return;
  const key = submission.receipt.submissionId + "/" + call.id;
  const existing = reporting.get(key);
  if (existing) return existing;
  const result = call.receipt;
  const pending = (async () => {
    const response = await fetch(
      "/api/chats/" + encodeURIComponent(submission.chat) + "/device-receipt",
      {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json", [plannerScopeHeader]: scope },
        body: JSON.stringify({
          submissionId: submission.receipt.submissionId,
          toolCallId: call.id,
          claim:await tabIdentity(),
          status: result.status,
          label: result.label,
        }),
      },
    );
    if (!response.ok) throw new Error("Device receipt delivery failed (" + response.status + ").");
    call.reported = true;
    persist();
  })().finally(() => reporting.delete(key));
  reporting.set(key, pending);
  return pending;
}

async function reviewOnDevice(scope:string,entry:Submission,call:StoredCall,status:"preview"|"authorize"){
  const claim=await tabIdentity();
  if(!claim || getVerifiedScope()!==scope)throw new Error("This preview requires its original browser tab.");
  const response=await fetch("/api/chats/"+entry.chat+"/device-receipt",{method:"POST",redirect:"error",
    headers:{"Content-Type":"application/json",[plannerScopeHeader]:scope},
    body:JSON.stringify({claim,submissionId:entry.receipt.submissionId,toolCallId:call.id,status,label:call.receipt?.label??"Device change",
      ...(status==="preview" && {changes:call.receipt?.changes})})});
  if(!response.ok)throw new Error((await response.json().catch(()=>({}))).error??"Device preview unavailable.");
  const result=await response.json() as {itemId?:string};
  if(result.itemId){call.previewId=result.itemId;persist();}
}
function replayCalls(j: Journal, entry: Submission, draft?: DraftSelection) {
  for (const call of entry.calls ?? []) {
    if (getVerifiedScope() !== j.scope) break;
    if (call.reported && useDeviceReceipts.getState().receipts[call.id]) continue;
    registerDeviceApproval(call.id,async()=>{
      if(!call.previewId)await reviewOnDevice(j.scope,entry,call,"preview");
      await reviewOnDevice(j.scope,entry,call,"authorize");
    });
    registerDeviceObserver(call.id, (receipt, executing) => {
      if (getVerifiedScope() !== j.scope) throw new Error("The active planner changed.");
      call.executing = executing;
      if (receipt) call.receipt = receipt;
      persist();
      if(receipt?.status==="waiting" && !executing)void reviewOnDevice(j.scope,entry,call,"preview").catch(()=>{});
      else if (receipt && !executing) void report(j.scope, entry, call).catch(() => {});
    });
    if (call.executing) {
      restoreDeviceReceipt(call.id, {
        status: "unavailable",
        label:
          "This tab closed while applying the action. Check the current view before trying again.",
      });
    } else if (call.receipt && call.receipt.status !== "waiting") {
      restoreDeviceReceipt(call.id, call.receipt);
    } else {
      executeDeviceCalls([call], entry.prefs, entry.originUrl, draft);
    }
  }
}
async function submissionDeviceCalls(client: FlueClient, id: string) {
  const options = { limit: 80 };
  let page: { messages: FlueConversationMessage[]; before?: string | null } = await client.history(options);
  const calls: DeviceCall[][] = [];
  const seen = new Set<string>();
  for (;;) {
    calls.push(incomingDeviceCalls(page.messages, id));
    // The originating user message precedes every tool call for this submission.
    if (!page.before || page.messages.some(message => message.role === "user" && message.submissionId === id))
      return calls.reverse().flat();
    if (seen.has(page.before)) throw new Error("Conversation history did not advance.");
    seen.add(page.before);
    page = await client.historyBefore(page.before, options);
  }
}

async function follow(j: Journal, entry: Submission, client: FlueClient, draft?: DraftSelection) {
  const id = entry.receipt.submissionId;
  const current = following.get(id);
  if (current) return current;
  const pending = (async () => {
    if (!entry.calls) {
      try {
        await client.wait({
          ...entry.receipt,
          streamUrl: new URL("/api/agents/copilot/" + entry.chat, location.origin).href,
        });
      } catch (error) {
        if (error instanceof FlueExecutionError) {
          delete j.entries[id];
          persist();
        }
        throw error;
      }
      if (getVerifiedScope() !== j.scope) return;
      const calls = await submissionDeviceCalls(client, id);
      if (getVerifiedScope() !== j.scope) return;
      entry.calls = calls;
      if (!entry.calls.length) {
        delete j.entries[id];
        persist();
        return;
      }
      persist();
    }
    replayCalls(j, entry, draft);
  })().finally(() => following.delete(id));
  following.set(id, pending);
  return pending;
}

export async function followDeviceSubmission(
  scope: string,
  chat: string,
  receipt: AgentSendResult,
  prefs: Preferences,
  originUrl: string,
  client: FlueClient,
  draft?: DraftSelection,
) {
  const j = await openJournal(scope);
  j.entries[receipt.submissionId] ??= { chat, receipt, prefs, originUrl };
  persist();
  return follow(j, j.entries[receipt.submissionId], client, draft);
}
export async function recoverDeviceSubmissions(
  scope: string,
  client: (chat: string) => FlueClient,
) {
  const j = await openJournal(scope);
  if (getVerifiedScope() !== scope) return;
  await Promise.allSettled(
    Object.values(j.entries).map((entry) => follow(j, entry, client(entry.chat))),
  );
}
