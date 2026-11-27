import type { FlueConversationMessage } from "@flue/sdk";
import { hasWorkspaceCall } from "./agents/device-receipt.ts";
import { connectors } from "./connectors/router.ts";
import { stableInboxKey, digestUuid } from "./core/agent-keys.ts";
import { z } from "zod";
import { env } from "cloudflare:workers";
import { instrument, setProvider } from "@flue/runtime";
import { createCloudflareTracing } from "@flue/runtime/cloudflare";
import { cloudflareBindingProvider } from "@flue/runtime/cloudflare/workers-ai";
import type { UserPlanner } from "./user-planner.ts";
import { sideConversation } from "./agents/chat-identity.ts";
import { createAgentRouter } from "@flue/runtime/routing";
import { plannerApi } from "./routes/planner-api.ts";
import { identify } from "./access.ts";
import { Copilot } from "./agents/copilot.ts";
import { chatScope } from "./interfaces/agents-workspace.ts";
import { chatId } from "./routes/chats.ts";
import { plannerOperations, publicOperations, openApiDocument } from "./routes/contract.ts";

// Flue recognizes an existing installation by the tracing object's identity.
const tracing = import.meta.hot?.data.tracing ?? createCloudflareTracing({ content: false });
if (import.meta.hot) import.meta.hot.data.tracing = tracing;
instrument(tracing);
if (env.AI)
  setProvider(
    cloudflareBindingProvider({
      binding: env.AI,
      gateway: { id: "default", collectLog: false, skipCache: true },
    }),
  );

type PlannerBindings = Omit<Env, "USER_PLANNER"> & {
  USER_PLANNER: DurableObjectNamespace<UserPlanner>;
};
const app = plannerApi<{ Bindings: PlannerBindings }>();
app.use(async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});
app.route("/", connectors);
app.openapi(publicOperations.health, (c) => c.json({ status: "ok" } as const, 200));
app.all(publicOperations.health.path, (c) => {
  c.header("Allow", "GET");
  return c.json({ error: "Method not allowed" }, 405);
});
app.openapi(publicOperations.openapi, (c) => c.json(openApiDocument(), 200));

async function dispatch(request: Request, env: PlannerBindings) {
  const identity = await identify(request, env);
  if (identity instanceof Response) return identity;
  const clean = new Request(request);
  for (const name of Array.from(clean.headers.keys())) {
    if (name.startsWith("x-2do-agent-")) clean.headers.delete(name);
  }
  clean.headers.set("x-2do-agent-owner", encodeURIComponent(identity));
  return env.USER_PLANNER.getByName(identity).fetch(clean);
}
for (const operation of Object.values(plannerOperations)) {
  app.on(operation.method, operation.getRoutingPath(), (c) => dispatch(c.req.raw, c.env));
}

const copilot = createAgentRouter(Copilot);
// Only internal dispatch can mint agent signals. The public composer uploads
// attachments to the owner-scoped image endpoint and sends their references.
const publicTurn = z.strictObject({
  kind: z.literal("user"),
  body: z.string(),
  attachments: z.array(z.strictObject({
    type:z.enum(["image","document"]),data:z.string(),mimeType:z.string(),filename:z.string().optional(),
  })).optional(),
  idempotencyKey: z.string().min(1).max(256).optional(),
  uid: z.string().nullable().optional(),
});
app.openapi(publicOperations.deviceReceipt, async (c) => {
  const identity = await identify(c.req.raw, c.env);
  if (typeof identity !== "string") return c.json({ error: "Sign in to continue." }, 401);
  const owner = c.env.USER_PLANNER.idFromName(identity).toString();
  if (c.req.header("X-Planner-Scope") !== owner)
    return c.json({ error: "Planner account changed." }, 412);
  const { chat } = c.req.valid("param"),
    value = c.req.valid("json");
  if (chat !== "me" && !(await c.env.USER_PLANNER.getByName(identity).hasSideChat(chat)))
    return c.json({ error: "Conversation missing." }, 404);
  const conversation = chat === "me" ? identity : sideConversation(identity, chat);
  const target = new URL("/" + encodeURIComponent(conversation), c.req.url);
  target.searchParams.set("view", "history");
  target.searchParams.set("limit", "200");
  const registered=await c.env.USER_PLANNER.getByName(identity).recordedDevicePreview(chat,value.submissionId,value.toolCallId);
  while (!registered) {
    const response = await copilot.fetch(new Request(target), c.env, c.executionCtx);
    if (!response.ok) return c.json({ error: "Conversation unavailable." }, 404);
    const page = await response.json<{
      messages: FlueConversationMessage[];
      before?: string | null;
    }>();
    if (hasWorkspaceCall(page.messages, value)) break;
    if (!page.before || page.before === target.searchParams.get("before"))
      return c.json({ error: "Workspace call unavailable." }, 409);
    target.searchParams.set("before", page.before);
  }
  const preview=await c.env.USER_PLANNER.getByName(identity).receiveDevicePreview(identity,chat,value);
  if(!preview.ok){const body=await preview.json<{error:string}>();return preview.status===403?c.json(body,403):c.json(body,409);}
  if(value.status==="preview"||value.status==="authorize")return c.json(await preview.json<{accepted:true;itemId?:string}>(),202);
  const result = await c.env.USER_PLANNER.getByName(identity).admitWorkspaceTurn(identity,chat,{
    idempotencyKey: "device:" + (await stableInboxKey([value.submissionId, value.toolCallId])),
    message: {
      kind: "signal",
      type: "device_result",
      body: value.label,
      attributes: { status: value.status, toolCallId: value.toolCallId },
    },
  });
  if(!result.ok) throw new Error("Device receipt admission failed.");
  return c.json({ accepted: true as const }, 202);
});
const mount = "/api/agents/copilot";
app.all(mount + "/*", async (c) => {
  const identity = await identify(c.req.raw, c.env);
  if (typeof identity !== "string") return identity;
  const url = new URL(c.req.url);
  const [chat, ...rest] = url.pathname.slice(mount.length + 1).split("/");
  let conversation = identity;
  if (chat !== "me" && chat !== encodeURIComponent(identity)) {
    if (
      !chatId.safeParse(chat).success ||
      !(await c.env.USER_PLANNER.getByName(identity).hasSideChat(chat))
    )
      return c.json({ error: "Not found" }, 404);
    conversation = sideConversation(identity, chat);
  }
  const publicUrl = url.href;
  url.pathname = ["/" + encodeURIComponent(conversation), ...rest].join("/");
  let incoming = new Request(url, c.req.raw);
  const resource = rest.join("/");
  if (incoming.method === "POST" && resource && resource !== "abort")
    return c.json({ error: "Unknown chat operation." }, 404);
  if (incoming.method === "POST" && resource === "") {
    const result = publicTurn.safeParse(await incoming.json().catch(() => null));
    if (!result.success) return c.json({ error: "Expected a user message." }, 400);
    const message = result.data;
    // Derive the marker from the SDK admission key so a network retry sends
    // byte-for-byte identical Flue input, including for non-UUID client keys.
    const key = message.idempotencyKey ?? crypto.randomUUID();
    const marker = digestUuid(await stableInboxKey([key]));
    let scope;
    try { scope=chatScope.parse(JSON.parse(incoming.headers.get("x-2do-context-scope") ?? "[]")); }
    catch { return c.json({error:"Invalid conversation references."},400); }
    const expected=incoming.headers.get("X-Planner-Scope");
    if(expected && expected!==c.env.USER_PLANNER.idFromName(identity).toString())return c.json({error:"Planner changed."},412);
    const {uid,attachments}=message;
    const claim=incoming.headers.get("x-2do-device-claim");
    if(claim && !z.uuid().safeParse(claim).success)return c.json({error:"Invalid originating tab."},400);
    const receipt=await c.env.USER_PLANNER.getByName(identity).admitWorkspaceTurn(identity,chat==="me"||conversation===identity?"me":chat,{
      idempotencyKey:key, ...(uid!==undefined&&{uid}),message:{kind:"user", body:`[2do turn ${marker}]\n${message.body}`,...(attachments&&{attachments})}
    },scope,claim??undefined);
    if(!receipt.ok)return receipt;
    return Response.json({...await receipt.json<object>(),streamUrl:publicUrl,offset:"-1"},{status:202,headers:{Location:publicUrl}});
  }
  const response = await copilot.fetch(incoming, c.env, c.executionCtx);
  // Flue generates the admission URL from its internal mount-relative request.
  if (response.status === 202 && response.headers.has("Location")) {
    const receipt = await response.json<{ streamUrl: string }>();
    const headers = new Headers(response.headers);
    headers.set("Location", publicUrl);
    return Response.json({ ...receipt, streamUrl: publicUrl }, { status: 202, headers });
  }
  return response;
});

export default app;
