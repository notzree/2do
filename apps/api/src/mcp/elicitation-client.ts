import {
  Client,
  StreamableHTTPClientTransport,
  isInputRequiredResult,
  SdkError,
  SdkErrorCode,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  elicitationView,
  type ElicitationView,
  type McpContinuation,
  type ElicitationReply,
} from "../interfaces/elicitation.ts";

// Registration belongs to the application. A fresh client can only replay a provider tool
// declared safe to repeat with the same arguments, input responses and opaque request state.
export class UnsupportedElicitation extends Error {}
export interface ElicitingProvider {
  id: string;
  name: string;
  endpoint: URL;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  tools: ReadonlyMap<string, { replay: "read-only" | "idempotent"; fields: ReadonlySet<string> }>;
  consentOrigins: ReadonlySet<string>;
}
export type ElicitationRound =
  | { kind: "complete"; text: string }
  | { kind: "question"; view: ElicitationView; continuation: McpContinuation };
const primitive = z.strictObject({
  type: z.enum(["string", "number", "integer", "boolean"]),
  title: z.string().max(200).optional(),
  description: z.string().max(1000).optional(),
  enum: z.array(z.string().max(200)).min(1).max(64).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.int().nonnegative().optional(),
  maxLength: z.int().nonnegative().optional(),
});
const form = z
  .object({
    type: z.literal("object"),
    title: z.string().optional(),
    description: z.string().optional(),
    properties: z.record(z.string().regex(/^[a-zA-Z][\w-]{0,80}$/), primitive),
    required: z.array(z.string()).optional(),
    additionalProperties: z.literal(false).optional(),
    $schema: z.string().optional(),
  })
  .strict();

function displayRequest(
  raw: unknown,
  config: ElicitingProvider,
  fields: ReadonlySet<string>,
): ElicitationView {
  const params = z
    .object({
      method: z.literal("elicitation/create"),
      params: z.object({
        mode: z.enum(["form", "url"]).optional(),
        message: z.string().min(1).max(2000),
        requestedSchema: z.unknown().optional(),
        url: z.string().max(2048).optional(),
      }),
    })
    .parse(raw).params;
  const common = { provider: config.name, message: params.message };
  if (params.mode === "url") {
    const target = new URL(params.url ?? "");
    if (
      target.protocol !== "https:" ||
      target.username ||
      target.password ||
      !config.consentOrigins.has(target.origin)
    )
      throw new UnsupportedElicitation(
        "This provider returned an unregistered consent destination.",
      );
    return { ...common, mode: "url", url: target.href, host: target.host };
  }
  const schema = form.parse(params.requestedSchema);
  if (schema.required?.some((key) => !Object.hasOwn(schema.properties, key)))
    throw new Error("Invalid required form field.");
  return elicitationView.parse({
    ...common,
    mode: "form",
    fields: Object.entries(schema.properties).map(([name, prop]) => {
      if (!fields.has(name) || ["constructor", "prototype", "__proto__"].includes(name))
        throw new UnsupportedElicitation("The provider requested an unregistered input.");
      if (prop.enum && prop.type !== "string") throw new Error("Unsupported choice field.");
      return {
        name,
        type: prop.type,
        label: prop.title ?? name,
        required: schema.required?.includes(name) ?? false,
        options: prop.enum,
        min: prop.minimum,
        max: prop.maximum,
        minLength: prop.minLength,
        maxLength: prop.maxLength,
      };
    }),
  });
}

export async function runElicitingTool(
  provider: ElicitingProvider,
  start: { workflow: string; tool: string; args: Record<string, unknown> },
  resume?: { continuation: McpContinuation; reply: ElicitationReply },
): Promise<ElicitationRound> {
  const { workflow, tool, args } = start,
    registered = provider.tools.get(tool);
  if (!registered || !["read-only", "idempotent"].includes(registered.replay))
    throw new Error("This provider operation cannot be resumed safely.");
  const saved = resume?.continuation;
  if (
    saved &&
    (saved.provider !== provider.id ||
      saved.tool !== tool ||
      saved.workflow !== workflow ||
      JSON.stringify(saved.args) !== JSON.stringify(args))
  )
    throw new Error("Connector continuation mismatch.");
  const client = new Client(
    { name: "2do-inbox", version: "1" },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      inputRequired: { autoFulfill: false },
    },
  );
  try {
    try {
      await client.connect(
        new StreamableHTTPClientTransport(provider.endpoint, {
          fetch: async (input, init) => {
            const request = new Request(input, { ...init, redirect: "manual" });
            const target = new URL(request.url);
            if (
              target.origin !== provider.endpoint.origin ||
              target.pathname !== provider.endpoint.pathname ||
              target.username ||
              target.password
            )
              throw new UnsupportedElicitation(
                "The connector cannot change its registered transport endpoint.",
              );
            const response = await provider.fetch(request);
            if (response.status >= 300 && response.status < 400)
              throw new UnsupportedElicitation("The connector transport returned a redirect.");
            return response;
          },
        }),
      );
    } catch (error) {
      if (error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed)
        throw new UnsupportedElicitation(
          "This provider does not support resumable MCP input. Open its connection settings to continue.",
        );
      throw error;
    }
    if (client.getServerVersion()?.name !== provider.id || !client.getServerCapabilities()?.tools)
      throw new UnsupportedElicitation(
        "Connector identity or tool capability did not match its registration.",
      );
    const params = {
      name: tool,
      arguments: args,
      ...(saved &&
        resume && {
          requestState: saved.requestState,
          inputResponses: {
            [saved.key]: {
              action: resume.reply.action,
              ...(resume.reply.action === "accept" &&
                resume.reply.values && { content: resume.reply.values }),
            },
          },
        }),
    };
    const result = await client.request(
      { method: "tools/call", params },
      { allowInputRequired: true },
    );
    if (!isInputRequiredResult(result)) {
      if (result.isError) throw new Error("Connector operation failed.");
      return {
        kind: "complete",
        text: result.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("\n")
          .slice(0, 2000),
      };
    }
    const requests = Object.entries(result.inputRequests ?? {}),
      round = (saved?.round ?? 0) + 1;
    if (round > 4 || requests.length !== 1 || (result.requestState?.length ?? 0) > 4096)
      throw new UnsupportedElicitation(
        "Unsupported connector interaction. Restart this operation from Connections.",
      );
    const [key, raw] = requests[0];
    if (!key || key.length > 160) throw new Error("Invalid connector input key.");
    let view: ElicitationView;
    try {
      view = displayRequest(raw, provider, registered.fields);
    } catch (error) {
      if (error instanceof UnsupportedElicitation) throw error;
      throw new UnsupportedElicitation(
        "This provider requested a form or interaction 2do does not support.",
      );
    }
    return {
      kind: "question",
      view,
      continuation: {
        workflow,
        round,
        provider: provider.id,
        tool,
        args,
        key,
        requestState: result.requestState,
      },
    };
  } finally {
    await client.close();
  }
}
