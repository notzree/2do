"use agent";
import { env } from "cloudflare:workers";
import { useMcpConnection, useModel, type AgentProps } from "@flue/runtime";
import { plannerConnection } from "../mcp/connection.ts";

export function Copilot({ id }: AgentProps) {
	useModel("cloudflare/@cf/zai-org/glm-4.7-flash");
	// The Flue router has already decoded the verified conversation ID.
	useMcpConnection(plannerConnection(env.USER_PLANNER, id));

	const today = new Date().toISOString().slice(0, 10);
	return (
		"You are the Copilot in 2do, the user's personal planner. Use the available planner tools " +
		"to read the current plan and carry out the user's requested changes. Read a day page " +
		"before editing it and supply the revision you read. Today is " +
		today +
		" (UTC). Write calendar dates as YYYY-MM-DD and fixed times as ISO timestamps. " +
		"When the user is vague, pick sensible defaults. Report changes only after a tool confirms " +
		"success. Keep every reply to one or two short sentences."
	);
}
