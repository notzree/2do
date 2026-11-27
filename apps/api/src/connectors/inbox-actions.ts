import { z } from "zod";
import { calendarLinkStatus, connectorKind, directions } from "../interfaces/connectors.ts";
import type { ConnectorEnv } from "./connection.ts";

export const connectorAgentToolNames = new Set([
  "guideGoogleConnection",
  "connectionStatus",
  "getCalendarLink",
  "calendarSyncDirections",
  "disconnectProvider",
  "setCalendarLink",
  "deletePublishedEvent",
]);

const action = z.discriminatedUnion("op", [
  z.object({ op: z.literal("calendarSyncDirections"), before: directions, after: directions }),
  z.object({ op: z.literal("disconnectProvider") }),
  z.object({
    op: z.literal("setCalendarLink"),
    taskId: z.uuid(),
    revision: z.int().nonnegative(),
    before: calendarLinkStatus,
    enabled: z.boolean(),
  }),
  z.object({
    op: z.literal("deletePublishedEvent"),
    taskId: z.uuid(),
    revision: z.int().nonnegative(),
  }),
]);

export const reviewedConnectorCommand = z.object({
  kind: connectorKind,
  generation: z.string().min(1),
  account: z.email(),
  action,
});
export type ReviewedConnectorCommand = z.infer<typeof reviewedConnectorCommand>;

export async function executeInboxConnector(
  env: Env,
  owner: string,
  operation: string,
  args: Record<string, unknown>,
  receiptId: string,
) {
  const command = reviewedConnectorCommand.parse(args);
  if (
    command.action.op !== operation ||
    (command.kind === "gmail" && operation !== "disconnectProvider")
  )
    throw new Error("Connector action does not match its approval.");
  const ns = (env as unknown as ConnectorEnv).GOOGLE_CONNECTION;
  return ns.getByName(command.kind + "/" + owner).executeReviewed(command, receiptId);
}
