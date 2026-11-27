import type { FlueConversationMessage } from "@flue/sdk";
import { create } from "zustand";
import { availableKeys, boundCommand, defaultBindings, type Preferences } from "./preferences.ts";
import { usePreferences } from "./preference-store.ts";
import { safeParse } from "valibot";
import { workspaceAction, type WorkspaceAction } from "@2do/api/workspace-command";
import { prepareDraftEdit, type DraftSelection } from "./agent-editor.ts";

type PreferenceDiff = { field: string; before: string; after: string };
export type DeviceReceipt = {
  status: "applied" | "waiting" | "rejected" | "unavailable";
  label: string;
  changes?: PreferenceDiff[];
};
export type DeviceCall = { id: string; action: WorkspaceAction };
const applyChanges = new Map<string, () => boolean>();

export const useDeviceReceipts = create<{ receipts: Record<string, DeviceReceipt> }>(() => ({
  receipts: {},
}));
type Observer = (receipt: DeviceReceipt | undefined, executing: boolean) => void;
const observers = new Map<string, Observer>();
export function registerDeviceObserver(id: string, observe: Observer) {
  observers.set(id, observe);
}
export function restoreDeviceReceipt(id: string, receipt: DeviceReceipt) {
  record(id, receipt);
}
function record(id: string, value: DeviceReceipt) {
  observers.get(id)?.(value, false);
  useDeviceReceipts.setState((state) => ({ receipts: { ...state.receipts, [id]: value } }));
}

export function incomingDeviceCalls(
  messages: FlueConversationMessage[],
  submissionId: string,
): DeviceCall[] {
  const calls: DeviceCall[] = [];
  for (const message of messages) {
    if (message.submissionId !== submissionId || message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (
        part.type !== "dynamic-tool" ||
        part.toolName !== "showWorkspace" ||
        part.state !== "output-available"
      )
        continue;
      const output = part.output;
      if (
        !output ||
        typeof output !== "object" ||
        !("clientCommand" in output) ||
        !("status" in output) ||
        output.status !== "awaiting_device"
      )
        continue;
      const validation = safeParse(workspaceAction, output.clientCommand);
      if (!validation.success) continue;
      const action = validation.output;
      calls.push({ id: part.toolCallId, action });
    }
  }
  return calls;
}

function queueDiff(id: string, label: string, changes: PreferenceDiff[], apply: () => boolean) {
  if (!changes.length) return record(id, { status: "applied", label: "Already up to date." });
  applyChanges.set(id, apply);
  record(id, { status: "waiting", label, changes });
}

export function executeDeviceCalls(
  calls: DeviceCall[],
  before: Preferences,
  originUrl: string,
  draft?: DraftSelection,
) {
  for (const { id, action } of calls) {
    if (useDeviceReceipts.getState().receipts[id]) continue;
    if (
      action.command === "editSelection" ||
      action.command === "undoDraft" ||
      action.command === "redoDraft"
    ) {
      const edit = draft && prepareDraftEdit(draft, action);
      if (edit) queueDiff(id, "Edit notebook draft", edit.changes, edit.apply);
      else
        record(id, {
          status: "unavailable",
          label: "Select an editable notebook passage in this tab and try again.",
        });
      continue;
    }
    if (
      action.command === "appearance" &&
      (action.theme ||
        action.mode ||
        action.weekStart !== undefined ||
        action.keysEnabled !== undefined ||
        action.binding ||
        action.resetBindings)
    ) {
      const patch: Partial<Preferences> = {};
      for (const field of ["theme", "mode", "weekStart", "keysEnabled"] as const) {
        if (action[field] !== undefined && action[field] !== before[field])
          Object.assign(patch, { [field]: action[field] });
      }
      if (action.resetBindings) patch.bindings = { ...defaultBindings };
      if (action.binding) {
        const bindings = patch.bindings ?? before.bindings;
        const { command, key } = action.binding;
        const occupied = boundCommand(bindings, key);
        if (!availableKeys.includes(key) || (occupied && occupied !== command)) {
          record(id, {
            status: "unavailable",
            label: "This shortcut is already assigned or reserved.",
          });
          continue;
        }
        patch.bindings = { ...bindings, [command]: key };
      }
      const keys = Object.keys(patch) as (keyof Preferences)[];
      const changes = keys.flatMap((field) =>
        field === "bindings"
          ? (Object.keys(before.bindings) as (keyof Preferences["bindings"])[])
              .filter((key) => before.bindings[key] !== patch.bindings?.[key])
              .map((key) => ({
                field: key + " shortcut",
                before: before.bindings[key],
                after: patch.bindings![key],
              }))
          : [{ field, before: String(before[field]), after: String(patch[field]) }],
      );
      queueDiff(id, "Change device preferences", changes, () => {
        const current = usePreferences.getState();
        if (keys.some((field) => JSON.stringify(before[field]) !== JSON.stringify(current[field])))
          return false;
        usePreferences.setState(patch);
        return true;
      });
      continue;
    }
    if (originUrl !== location.href) {
      record(id, {
        status: "unavailable",
        label: "Your view changed before this request arrived.",
      });
      continue;
    }
    observers.get(id)?.(undefined, true);
    let handled = false;
    const finish = (ok: boolean) => record(id, {
      status: ok ? "applied" : "unavailable",
      label: ok ? "Opened in this tab." : "The selected task is unavailable.",
    });
    window.dispatchEvent(
      new CustomEvent("agent-workspace-command", {
        detail: {
          action,
          reply: (result: boolean | Promise<boolean>) => {
            handled = true;
            if (typeof result === "boolean") finish(result);
            else void result.then(finish, () => finish(false));
          },
        },
      }),
    );
    if (!handled) record(id, { status: "unavailable", label: "This view is unavailable." });
  }
}
export type WorkspaceCommandEvent = CustomEvent<{
  action: WorkspaceAction;
  reply: (result: boolean | Promise<boolean>) => void;
}>;
const approvals=new Map<string,()=>Promise<void>>();
const resolving=new Set<string>();
export const useDeviceErrors=create<{errors:Record<string,string>}>(()=>({errors:{}}));
export function registerDeviceApproval(id:string,approve:()=>Promise<void>){approvals.set(id,approve);}
export async function resolveDeviceChange(id:string,apply:boolean){
  if(resolving.has(id))return;
  resolving.add(id);
  try{
    if(apply && approvals.has(id))await approvals.get(id)!();
    applyDeviceChange(id,apply);
    approvals.delete(id);
  }catch(error){useDeviceErrors.setState(s=>({errors:{...s.errors,[id]:error instanceof Error?error.message:"Could not validate this preview."}}));}
  finally{resolving.delete(id);}
}
function applyDeviceChange(id: string, apply: boolean) {
  const receipt = useDeviceReceipts.getState().receipts[id];
  if (receipt?.status !== "waiting" || !receipt.changes) return;
  const execute = applyChanges.get(id);
  applyChanges.delete(id);
  if (!apply) return record(id, { status: "rejected", label: "Declined." });
  observers.get(id)?.(undefined, true);
  const success = execute?.();
  record(
    id,
    success
      ? { status: "applied", label: "Applied on this device." }
      : {
          status: "unavailable",
          label: "The original value changed. Ask again to preview the latest version.",
        },
  );
}
