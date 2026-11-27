import { defineMcpConnection } from "@flue/runtime";
import { connectionOperations as ops, connectionGuideResult } from "../routes/connections.ts";
import { plannerApi } from "../routes/planner-api.ts";
import { plannerMcpHandler } from "../mcp/server.ts";
import { agentTurn } from "../mcp/connection.ts";
import { task } from "../interfaces/plan.ts";
import { connectorLabels, type ConnectorKind } from "../interfaces/connectors.ts";
import type { ConnectorEnv } from "./connection.ts";
import { connectorAgentToolNames, type ReviewedConnectorCommand } from "./inbox-actions.ts";
import { HTTPException } from "hono/http-exception";

type Change = { field: string; before: unknown; after: unknown };

export function connectorConnection(bindings: Env, identity: string, conversation: string) {
  const env = bindings as unknown as ConnectorEnv;
  const owner = env.USER_PLANNER.idFromName(identity).toString();
  const planner = () => env.USER_PLANNER.getByName(identity);
  const connection = (kind: ConnectorKind) => env.GOOGLE_CONNECTION.getByName(kind + "/" + owner);

  async function propose(
    kind: ConnectorKind,
    action: ReviewedConnectorCommand["action"],
    title: string,
    changes: Change[],
  ) {
    const context = await connection(kind).reviewContext(kind);
    if (!context)
      throw new HTTPException(409, { message: "Connect this Google account in Settings first." });
    const args = { kind, generation: context.generation, account: context.account, action };
    const turn = agentTurn(conversation);
    const source = JSON.stringify([conversation, turn?.submission ?? crypto.randomUUID(), args]);
    const digest = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)),
    ).toString("hex");
    return planner().proposeConnector({
      id: digest,
      operation: action.op,
      args,
      origin: turn?.origin,
      submission: turn?.submission,
      replaces: turn?.replaces,
      title,
      changes: [
        { field: "Google account", before: context.account, after: context.account },
        ...changes,
      ],
      conversation,
    });
  }
  async function event(id: string) {
    const response = await planner().fetch("https://planner.internal/api/tasks/" + id);
    if (!response.ok) throw new HTTPException(404, { message: "Event missing." });
    return task.parse(await response.json());
  }

  const app = plannerApi()
    .openapi(ops.guide, async (c) =>
      c.json(
        connectionGuideResult.parse(
          await planner().startConnectionGuide(
            agentTurn(conversation)?.submission ?? crypto.randomUUID(),
            c.req.valid("json"),
            conversation,
          ),
        ),
        200,
      ),
    )
    .openapi(ops.status, async (c) =>
      c.json(await connection(c.req.valid("param").kind).status(c.req.valid("param").kind), 200),
    )
    .openapi(ops.readLink, async (c) =>
      c.json({ status: await planner().calendarLinkStatus(c.req.valid("param").id) }, 200),
    );
  // Human routes return provider state. On the agent transport every change
  // returns the immutable proposal receipt and goes through an inbox decision.
  app.put(ops.options.path, async (c) => {
    const context = await connection("google-calendar").reviewContext("google-calendar");
    if (!context) throw new HTTPException(409, { message: "Connect Google Calendar first." });
    const after = ops.options.request.body.content["application/json"].schema.parse(
      await c.req.json(),
    );
    return c.json(
      await propose(
        "google-calendar",
        { op: "calendarSyncDirections", before: context.directions, after },
        "Change Google Calendar sync directions",
        [{ field: "Sync directions", before: context.directions, after }],
      ),
    );
  });
  app.delete(ops.remove.getRoutingPath(), async (c) => {
    const { kind } = ops.remove.request.params.parse(c.req.param());
    return c.json(
      await propose(
        kind,
        { op: "disconnectProvider" },
        "Disconnect " + connectorLabels[kind] + (kind === "google-health" ? " and remove its imported workouts" : ""),
        [{ field: "Connection", before: "Connected", after: "Disconnected" }],
      ),
    );
  });
  app.put(ops.link.getRoutingPath(), async (c) => {
    const { id } = ops.link.request.params.parse(c.req.param());
    const { enabled } = ops.link.request.body.content["application/json"].schema.parse(
      await c.req.json(),
    );
    const current = await event(id);
    const before = await planner().calendarLinkStatus(id);
    return c.json(
      await propose(
        "google-calendar",
        { op: "setCalendarLink", taskId: id, revision: current.revision, before, enabled },
        (enabled ? "Publish " : "Stop syncing ") + current.title,
        [
          {
            field: "Google Calendar sync",
            before,
            after: enabled ? "Publish to 2do calendar" : "Unlinked",
          },
          {
            field: "Event",
            before: null,
            after: { title: current.title, schedule: current.schedule },
          },
        ],
      ),
    );
  });
  app.delete(ops.deleteEvent.getRoutingPath(), async (c) => {
    const { id } = ops.deleteEvent.request.params.parse(c.req.param());
    const { revision } = ops.deleteEvent.request.query.parse(c.req.query());
    const current = await event(id);
    if (current.revision !== revision)
      throw new HTTPException(409, { message: "Event changed. Read the current version." });
    return c.json(
      await propose(
        "google-calendar",
        { op: "deletePublishedEvent", taskId: id, revision },
        "Delete " + current.title + " from 2do and Google Calendar",
        [{ field: "Both event copies", before: current, after: null }],
      ),
    );
  });
  const mcp = plannerMcpHandler(
    (request) => Promise.resolve(app.fetch(request)),
    (name) => connectorAgentToolNames.has(name),
  );
  return defineMcpConnection({
    name: "google",
    url: "https://connectors.internal/mcp",
    fetch: (input, init) => mcp.fetch(new Request(input, init)),
  });
}
