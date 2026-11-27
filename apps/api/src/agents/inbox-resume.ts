import type { WorkspaceInput } from "./workspace-runtime.ts";

export async function resumeInboxConversation(
  item: {
    id: string;
    conversation?: string;
    status: string;
    answer?: string;
    title: string;
    version: number;
  },
  send: (target: string, input: WorkspaceInput) => Promise<void>,
) {
  if (!item.conversation) return;
  await send(item.conversation, {
    idempotencyKey: "inbox:" + item.id + ":" + item.version + ":" + item.status,
    message: {
      kind: "signal",
      type: item.status === "revision-requested" ? "inbox_revision" : "inbox_result",
      body: JSON.stringify({ title: item.title, status: item.status, answer: item.answer }),
      attributes: { itemId: item.id, version: String(item.version), status: item.status },
    },
  });
}
