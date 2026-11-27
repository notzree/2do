import { z } from "zod";
import { createRoute } from "@hono/zod-openapi";
import { jsonBody, jsonResponse, accessErrors, conflict, missing } from "../routes/responses.ts";
import { jsonLimits } from "../routes/json-body.ts";
import type { FlueConversationMessage } from "@flue/sdk";

export const deviceReceipt = z.strictObject({
  submissionId: z.string().min(1).max(180),
  toolCallId: z.string().min(1).max(180),
  status: z.enum(["preview","authorize","applied", "rejected", "unavailable"]),
  claim:z.uuid().optional(),
  changes:z.array(z.strictObject({field:z.string().max(240),before:z.string().max(4000),after:z.string().max(4000)})).max(32).optional(),
  label: z.string().trim().min(1).max(240),
});
export const deviceReceiptOperation = createRoute({
  path: "/api/chats/{chat}/device-receipt",
  method: "post",
  operationId: "recordDeviceReceipt",
  summary: "Report the result of a workspace command to its originating conversation",
  middleware: jsonLimits(),
  request: {
    params: z.object({ chat: z.union([z.literal("me"), z.uuid()]) }),
    body: jsonBody(deviceReceipt),
  },
  responses: {
    202: jsonResponse(z.object({ accepted: z.literal(true),itemId:z.string().optional() })),
    ...accessErrors,
    404: missing,
    409: conflict,
    403:jsonResponse(z.object({error:z.string()}),"The originating browser tab is required"),
  },
});
export function hasWorkspaceCall(
  messages: FlueConversationMessage[],
  value: z.infer<typeof deviceReceipt>,
) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.submissionId === value.submissionId &&
      message.parts.some(
        (part) =>
          part.type === "dynamic-tool" &&
          part.toolName === "showWorkspace" &&
          part.toolCallId === value.toolCallId &&
          part.state === "output-available",
      ),
  );
}
