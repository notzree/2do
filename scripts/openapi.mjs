import { readFileSync, writeFileSync } from "node:fs";
import openapiTS, { astToString, COMMENT_HEADER } from "openapi-typescript";
import ts from "typescript";
import { getToolsFromOpenApi } from "openapi-mcp-generator";
import { openApiDocument } from "../apps/api/src/routes/contract.ts";

function emit(path, content) {
	const file = new URL(path, import.meta.url);
	if (process.argv.includes("--check")) {
		if (readFileSync(file, "utf8") !== content)
			throw new Error(`Run npm run openapi to update ${path}`);
	} else {
		writeFileSync(file, content);
	}
}

function emitJson(path, value) {
	emit(path, JSON.stringify(value, null, 2) + "\n");
}

const spec = openApiDocument();
emitJson("../apps/api/openapi.json", spec);
const types = await openapiTS(spec, {
	defaultNonNullable: false,
	transform(schema) {
		if (schema.type === "string" && schema.format === "binary")
			return ts.factory.createTypeReferenceNode("Blob");
	},
});
emit("../apps/web/client/openapi.d.ts", COMMENT_HEADER + astToString(types));
const tools = await getToolsFromOpenApi(spec, { dereference: true, defaultInclude: false });
emitJson(
	"../apps/api/src/mcp/tools.json",
	tools.map(
		({
			name,
			description,
			annotations,
			inputSchema,
			method,
			pathTemplate,
			executionParameters,
			requestBodyContentType,
		}) => {
			const queryParameters = executionParameters.filter((p) => p.in === "query").map((p) => p.name);
			return {
				name,
				description,
				annotations,
				inputSchema,
				method,
				pathTemplate,
				queryParameters: queryParameters.length ? queryParameters : undefined,
				requestBodyContentType,
			};
		},
	),
);
