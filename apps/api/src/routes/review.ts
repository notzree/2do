import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";
import type { Review } from "../core/review.ts";
import {
	decision,
	proposeTime,
	recentDecision,
	reviewItem,
	timeProposal,
} from "../interfaces/review.ts";
import { jsonLimits } from "./json-body.ts";
import {
	accessErrors,
	conflict,
	jsonBody,
	jsonErrors,
	jsonResponse,
	missing,
	named,
} from "./responses.ts";

export type PlannerCaller = { Bindings: { fromAgent?: boolean } };
const userOnly = jsonResponse(z.object({ error: z.string() }), "A user decision is required");
function requireUser(fromAgent?: boolean) {
	if (fromAgent) throw new HTTPException(403, { message: "Only the user can decide a proposal." });
}
export const reviewOperations = {
	listReview: createRoute({
		method: "get",
		path: "/api/review",
		operationId: "listReview",
		summary: "Read pending time changes",
		"x-mcp": true,
		responses: { 200: jsonResponse(z.array(reviewItem)), ...accessErrors },
	}),
	listRecentDecisions: createRoute({
		method: "get",
		path: "/api/review/recent",
		operationId: "listRecentDecisions",
		summary: "Read the ten most recent decisions, newest first",
		responses: { 200: jsonResponse(z.array(recentDecision)), ...accessErrors },
	}),
	proposeTime: createRoute({
		method: "post",
		path: "/api/review",
		operationId: "proposeTime",
		"x-mcp": true,
		summary: "Propose moving a fixed event for user review. The accepted schedule stays in place.",
		middleware: jsonLimits(),
		request: { body: jsonBody(proposeTime) },
		responses: {
			200: jsonResponse(named(timeProposal, "TimeProposal")),
			...accessErrors,
			...jsonErrors,
			404: missing,
			409: conflict,
		},
	}),
	decideTime: createRoute({
		method: "post",
		path: "/api/review/{id}/decision",
		operationId: "decideTime",
		summary: "Accept or reject the stored time change",
		middleware: jsonLimits(),
		request: { params: z.object({ id: z.uuid() }), body: jsonBody(decision) },
		responses: {
			200: jsonResponse(named(timeProposal, "TimeProposal")),
			...accessErrors,
			...jsonErrors,
			403: userOnly,
			404: missing,
			409: conflict,
		},
	}),
	undoTime: createRoute({
		method: "post",
		path: "/api/review/{id}/undo",
		operationId: "undoTime",
		summary: "Restore the prior schedule at the exact revision recorded at acceptance",
		request: { params: z.object({ id: z.uuid() }) },
		responses: {
			200: jsonResponse(named(timeProposal, "TimeProposal")),
			...accessErrors,
			400: jsonErrors[400],
			403: userOnly,
			404: missing,
			409: conflict,
		},
	}),
};
export function reviewRoutes(review: Review) {
	const app = new OpenAPIHono<PlannerCaller>();
	app.openapi(reviewOperations.listReview, (c) => c.json(review.pending(), 200));
	app.openapi(reviewOperations.listRecentDecisions, (c) => c.json(review.recent(), 200));
	app.openapi(reviewOperations.proposeTime, (c) =>
		c.json(review.propose(c.req.valid("json"), c.env?.fromAgent ? "copilot" : "user"), 200),
	);
	app.openapi(reviewOperations.decideTime, (c) => {
		requireUser(c.env?.fromAgent);
		return c.json(review.decide(c.req.valid("param").id, c.req.valid("json").decision), 200);
	});
	app.openapi(reviewOperations.undoTime, (c) => {
		requireUser(c.env?.fromAgent);
		return c.json(review.undo(c.req.valid("param").id), 200);
	});
	return app;
}
