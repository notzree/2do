import { readFileSync, writeFileSync } from "node:fs";
import { getToolsFromOpenApi } from "openapi-mcp-generator";
import { openApiDocument } from "../apps/api/src/routes/contract.ts";

function emit(path, value) {
	const file = new URL(path, import.meta.url);
	const content = JSON.stringify(value, null, 2) + "\n";
	if (process.argv.includes("--check")) {
		if (readFileSync(file, "utf8") !== content)
			throw new Error(`Run npm run openapi to update ${path}`);
	} else {
		writeFileSync(file, content);
	}
}

const spec = openApiDocument();
emit("../apps/api/openapi.json", spec);
const tools = await getToolsFromOpenApi(spec, { dereference: true, defaultInclude: false });
emit(
	"../apps/api/src/mcp/tools.json",
	tools.map(
		({
			name,
			description,
			annotations,
			inputSchema,
			method,
			pathTemplate,
			requestBodyContentType,
		}) => ({
			name,
			description,
			annotations,
			inputSchema,
			method,
			pathTemplate,
			requestBodyContentType,
		}),
	),
);
