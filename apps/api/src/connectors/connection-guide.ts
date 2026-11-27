import { Server, createMcpHandler, inputRequired } from "@modelcontextprotocol/server";
import { z } from "zod";
import { connectorKind as service, connectorLabels, type ConnectorKind } from "../interfaces/connectors.ts";
import type { ElicitingProvider } from "../mcp/elicitation-client.ts";

// This server only reads connection status. OAuth itself stays in the normal
// authenticated Connections page. A URL-mode acceptance never grants permission.
export const guideTool = "guideGoogleConnection";
const argsSchema = z.strictObject({ kind: service.optional() });
export function connectionGuide(
  origin: string | undefined,
  status: (kind: ConnectorKind) => Promise<{ account: string | null; configured: boolean }>,
): ElicitingProvider {
  const endpoint = new URL("https://google-connection-guide.internal/mcp");
  const provider = createMcpHandler(() => {
    const s = new Server(
      { name: "2do-google-connections", version: "1" },
      { capabilities: { tools: {} } },
    );
    s.setRequestHandler("tools/list", () => ({
      tools: [
        {
          name: guideTool,
          description: "Connect or inspect a Google service",
          inputSchema: {
            type: "object",
            properties: { kind: { type: "string", enum: service.options } },
          },
        },
      ],
    }));
    s.setRequestHandler("tools/call", async ({ params }, ctx) => {
      if (params.name !== guideTool) throw new Error("Unknown guide operation.");
      const args = argsSchema.parse(params.arguments ?? {});
      const responses = ctx.mcpReq.inputResponses;
      const state = ctx.mcpReq.requestState<string>();
      const done = (text: string) => ({ content: [{ type: "text" as const, text }] });
      let kind = args.kind;
      if (state === "choose-service") {
        const result = z
          .object({
            action: z.enum(["accept", "decline", "cancel"]),
            content: z.object({ service }).optional(),
          })
          .parse(responses?.service);
        if (result.action !== "accept")
          return done(
            "The connection request was " +
              (result.action === "cancel" ? "canceled." : "declined."),
          );
        kind = service.parse(result.content?.service);
      } else if (state?.startsWith("visit:")) {
        kind = service.parse(state.slice(6));
        const response = z
          .object({ action: z.enum(["accept", "decline", "cancel"]) })
          .parse(responses?.consent);
        if (response.action !== "accept")
          return done(
            "The connection request was " +
              (response.action === "cancel" ? "canceled." : "declined."),
          );
      } else if (state !== undefined || responses !== undefined)
        throw new Error("Unknown guide continuation.");
      if (!kind)
        return inputRequired({
          requestState: "choose-service",
          inputRequests: {
            service: inputRequired.elicit({
              message: "Which Google service would you like to connect?",
              requestedSchema: {
                type: "object",
                properties: {
                  service: { title: "Google service", type: "string", enum: service.options },
                },
                required: ["service"],
              },
            }),
          },
        });
      const actual = await status(kind);
      const label = connectorLabels[kind];
      if (actual.account) return done(label + " is connected to " + actual.account + ".");
      if (!actual.configured || !origin)
        return done(label + " is unavailable until Google OAuth is configured for this planner.");
      if (state?.startsWith("visit:"))
        return done(
          label + " is still disconnected. Finish Google consent in Connections and check again.",
        );
      return inputRequired({
        requestState: "visit:" + kind,
        inputRequests: {
          consent: inputRequired.elicitUrl({
            message:
              "Open 2do Connections to authorize " + label + " with Google, then return here.",
            url: new URL("/app/settings?section=connections", origin).href,
          }),
        },
      });
    });
    return s;
  });
  return {
    id: "2do-google-connections",
    name: "2do Google Connections",
    endpoint,
    fetch: (input, init) => provider.fetch(new Request(input, init)),
    tools: new Map([[guideTool, { replay: "read-only", fields: new Set(["service"]) }]]),
    consentOrigins: new Set(origin ? [new URL(origin).origin] : []),
  };
}
