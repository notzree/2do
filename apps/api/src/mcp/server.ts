import { Validator, type Schema } from "@cfworker/json-schema";
import {
	createMcpHandler,
	ProtocolError,
	ProtocolErrorCode,
	Server,
	type Tool,
} from "@modelcontextprotocol/server";
import definitions from "./tools.json";

const catalog = definitions.map(({ name, description, annotations, inputSchema, ...route }) => ({
	tool: { name, description, annotations, inputSchema: inputSchema as Tool["inputSchema"] },
	route,
	validate: new Validator(structuredClone(inputSchema) as Schema, "2020-12"),
}));

// The caller supplies a fetch bound to one planner. Tool arguments can only fill
// parameters of a registered route and never select a planner or an upstream host.
export function plannerMcpHandler(dispatch: (request: Request) => Promise<Response>) {
	return createMcpHandler(() => {
		const server = new Server(
			{ name: "2do-planner", version: "1.0.0" },
			{ capabilities: { tools: {} } },
		);
		server.setRequestHandler("tools/list", () => ({ tools: catalog.map(({ tool }) => tool) }));
		server.setRequestHandler("tools/call", async ({ params }) => {
			const entry = catalog.find(({ tool }) => tool.name === params.name);
			if (!entry) throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown planner tool");
			const args = params.arguments ?? {};
			const validation = entry.validate.validate(args);
			if (!validation.valid) {
				const error = validation.errors.at(-1);
				return {
					isError: true,
					content: [
						{ type: "text", text: `Invalid input ${error?.instanceLocation}: ${error?.error}` },
					],
				};
			}
			const { route } = entry;
			const path = route.pathTemplate.replace(/\{(\w+)\}/g, (_, key: string) =>
				encodeURIComponent(String(args[key])),
			);
			const url = new URL("https://planner.internal" + path);
			for (const key of route.queryParameters ?? []) {
				if (args[key] !== undefined) url.searchParams.set(key, String(args[key]));
			}
			const response = await dispatch(
				new Request(url, {
					method: route.method,
					...(route.requestBodyContentType && {
						headers: { "Content-Type": route.requestBodyContentType },
						body: JSON.stringify(args.requestBody),
					}),
				}),
			);
			const text = await response.text();
			return {
				isError: !response.ok,
				content: [{ type: "text", text: text || `HTTP ${response.status}` }],
			};
		});
		return server;
	});
}
