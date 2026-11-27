import { defineTool } from "@flue/runtime";
import { workspaceAction } from "../interfaces/workspace-command.ts";

export const showWorkspace = defineTool({
  name: "showWorkspace",
  description:
    "Request an action in the submitting browser. Use command week to open Week and calendar to open Month. Supply an optional date. previousMonth and nextMonth change the displayed month only when asked to go backward or forward. You can also inspect a task or graph, open the palette, start capture, switch chat, or open Connections for OAuth. Use appearance for device preferences and shortcut bindings. Use editSelection, undoDraft or redoDraft for the user's current local notebook draft. Use inbox with itemId and inboxAction for read, unread, archive or guarded time undo. Use gmailSuggestions to take the user to the content-processing consent control. The device previews and applies saved changes.",
  input: workspaceAction,
  run({ data }) {
    if ((data.command === "inspectTask" || data.command === "graph") && !data.taskId)
      throw new Error("Choose a task to inspect.");
    if (data.command === "inbox" && data.inboxAction && !data.itemId)
      throw new Error("Choose an inbox item.");
    if (data.command === "switchChat" && !data.chatId) throw new Error("Choose a conversation.");
    if (
      data.command === "editSelection" &&
      (!data.edit || (data.edit === "replace" && data.text === undefined))
    )
      throw new Error("Choose a selection edit and supply replacement text when replacing.");
    return { output: { clientCommand: data, status: "awaiting_device" } };
  },
});
