import { HTTPException } from "hono/http-exception";
import { errors } from "jose";
import { z } from "zod";
import { identify } from "../access.ts";
import { verifiedGoogleIdentity } from "./auth.ts";
import type { ConnectorEnv } from "./connection.ts";
import { plannerApi } from "../routes/planner-api.ts";
import { connectionOperations as ops, connectionGuideResult } from "../routes/connections.ts";
import { plannerScopeHeader } from "../interfaces/notebook.ts";
import type { ConnectorKind } from "../interfaces/connectors.ts";
import { bodyLimit } from "hono/body-limit";

type Bindings = ConnectorEnv & Pick<Env, "ACCESS_ISSUER" | "ACCESS_AUD" | "LOCAL_PLANNER">;
type Context = { Bindings: Bindings; Variables: { owner: string } };
const notice = z.object({
  subscription: z.string(),
  message: z.object({ data: z.string().max(4096) }),
});
const mailbox = z.object({ emailAddress: z.email(), historyId: z.union([z.string(), z.number()]) });
export const connectors = plannerApi<Context>();
connectors.post("/hooks/gmail", bodyLimit({ maxSize: 16_384 }), async (c) => {
  const { GOOGLE_CONNECTOR_ORIGIN, GMAIL_PUSH_SERVICE_ACCOUNT, GMAIL_PUSH_SUBSCRIPTION } = c.env;
  if (!GOOGLE_CONNECTOR_ORIGIN || !GMAIL_PUSH_SERVICE_ACCOUNT || !GMAIL_PUSH_SUBSCRIPTION)
    return c.body(null, 503);
  const bearer = c.req.header("Authorization");
  if (!bearer?.startsWith("Bearer ")) return c.body(null, 401);
  try {
    const identity = await verifiedGoogleIdentity(
      bearer.slice(7),
      new URL("/hooks/gmail", GOOGLE_CONNECTOR_ORIGIN).href,
    );
    if (identity.email !== GMAIL_PUSH_SERVICE_ACCOUNT.toLowerCase()) return c.body(null, 403);
  } catch (e) {
    if (e instanceof errors.JWKSTimeout || !(e instanceof errors.JOSEError))
      return c.body(null, 503);
    return c.body(null, 401);
  }
  const body = notice.safeParse(await c.req.json().catch(() => null));
  if (!body.success || body.data.subscription !== GMAIL_PUSH_SUBSCRIPTION) return c.body(null, 400);
  let info;
  try {
    info = mailbox.parse(JSON.parse(atob(body.data.message.data)));
  } catch {
    return c.body(null, 400);
  }
  const email = info.emailAddress.toLowerCase();
  const id = await c.env.GMAIL_DIRECTORY.getByName(email).owner();
  if (id) await c.env.GOOGLE_CONNECTION.get(c.env.GOOGLE_CONNECTION.idFromString(id)).wake(email);
  return c.body(null, 204);
});
connectors.post("/hooks/google-calendar", async (c) => {
  const value = c.req.header("X-Goog-Channel-Token") ?? "";
  const match = /^([a-f0-9]{64})\.([a-f0-9-]{36})$/.exec(value);
  const channel = c.req.header("X-Goog-Channel-ID");
  const resource = c.req.header("X-Goog-Resource-ID");
  if (!match || !channel || !resource) return c.body(null, 403);
  let id;
  try {
    id = c.env.GOOGLE_CONNECTION.idFromString(match[1]);
  } catch {
    return c.body(null, 403);
  }
  const valid = await c.env.GOOGLE_CONNECTION.get(id).calendarNotice(channel, match[2], resource);
  return c.body(null, valid ? 204 : 403);
});
const guard = async (c: import("hono").Context<Context>, next: import("hono").Next) => {
  const identity = await identify(c.req.raw, c.env);
  if (identity instanceof Response) return identity;
  const owner = c.env.USER_PLANNER.idFromName(identity).toString();
  const expected = c.req.header(plannerScopeHeader);
  if (expected && expected !== owner) return c.json({ error: "Planner account changed." }, 412);
  const origin = c.req.header("Origin");
  if (
    c.req.method !== "GET" &&
    origin &&
    origin !== (c.env.GOOGLE_CONNECTOR_ORIGIN ?? new URL(c.req.url).origin)
  )
    return c.json({ error: "Invalid request origin." }, 403);
  c.set("owner", owner);
  c.header(plannerScopeHeader, owner);
  await next();
};
connectors.use("/api/connections/*", guard);
connectors.use("/api/events/:id/calendar-link", guard);
function connection(c: import("hono").Context<Context>, kind: ConnectorKind) {
  return c.env.GOOGLE_CONNECTION.getByName(kind + "/" + c.get("owner"));
}
function planner(c: import("hono").Context<Context>) {
  return c.env.USER_PLANNER.get(c.env.USER_PLANNER.idFromString(c.get("owner")));
}
connectors.openapi(ops.guide,async c=>c.json(connectionGuideResult.parse(await planner(c).startConnectionGuide(crypto.randomUUID(),c.req.valid("json"))),200));
connectors.openapi(ops.status, async (c) => {
  const { kind } = c.req.valid("param");
  return c.json(await connection(c, kind).status(kind), 200);
});
connectors.openapi(ops.begin, async (c) => {
  const { kind } = c.req.valid("param");
  const body = c.req.valid("json");
  if (kind === "google-calendar" && !("importEvents" in body))
    throw new HTTPException(400, { message: "Choose your calendar sync directions." });
  const options = {
    importEvents: kind === "google-calendar" && body.importEvents === true,
    exportEvents: kind === "google-calendar" && body.exportEvents === true,
  };
  const result = await connection(c, kind).begin(c.get("owner"), kind, options);
  if ("error" in result) throw new HTTPException(result.status, { message: result.error });
  return c.json({ url: result.url }, 200);
});
connectors.openapi(ops.callback, async (c) => {
  const { code, state } = c.req.valid("query");
  if (!code) return c.text("Google access was declined. Return to 2do Settings to try again.", 400);
  const error = await connection(c, c.req.valid("param").kind).complete(state, code);
  if (error) return c.text(error, 400);
  return c.redirect(
    new URL("/app/settings?section=connections", c.env.GOOGLE_CONNECTOR_ORIGIN).href,
    303,
  );
});
connectors.openapi(ops.recentWorkouts, async (c) => c.json(await planner(c).recentWearableWorkouts(), 200));
connectors.openapi(ops.mailSuggestions, async (c) => {
  const {enabled} = c.req.valid("json");
  if (!(await connection(c, "gmail").setMailSuggestions(enabled)))
    return c.json({error:"Connect Gmail first."}, 409);
  return c.json({enabled}, 200);
});
connectors.openapi(ops.options, async (c) =>
  c.json({ authorized: await connection(c, "google-calendar").options(c.req.valid("json")) }, 200),
);
connectors.openapi(ops.remove, async (c) => {
  await connection(c, c.req.valid("param").kind).disconnect();
  return c.body(null, 204);
});
connectors.openapi(ops.readLink, async (c) =>
  c.json({ status: await planner(c).calendarLinkStatus(c.req.valid("param").id) }, 200),
);
connectors.openapi(ops.link, async (c) => {
  const id = c.req.valid("param").id;
  if (!(await connection(c, "google-calendar").link(id, c.req.valid("json").enabled)))
    return c.json({ error: "Enable calendar export in Connections first." }, 409);
  return c.json({ status: await planner(c).calendarLinkStatus(id) }, 200);
});

connectors.openapi(ops.deleteEvent, async (c) => {
  const ok = await connection(c, "google-calendar").deleteEvent(
    c.req.valid("param").id,
    c.req.valid("query").revision,
  );
  if (!ok)
    return c.json(
      { error: "Refresh the published event and enable export before deleting both copies." },
      409,
    );
  return c.json({ queued: true as const }, 202);
});
