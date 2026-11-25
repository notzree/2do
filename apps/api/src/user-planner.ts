import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migratePlanner } from "./db/migrate.ts";
import { ClefTaskClassifier } from "./classifiers/clef.ts";
import { Notebook } from "./core/notebook.ts";
import { Planner } from "./core/planner.ts";
import { TaskClassification } from "./core/task-classification.ts";
import { TaskPlugins } from "./core/task-plugins.ts";
import { TaskSummaries } from "./core/task-summaries.ts";
import { Review } from "./core/review.ts";
import { SqlitePlannerDatabase } from "./db/planner.ts";
import { PlannerImages } from "./db/planner-images.ts";
import { sideChats, taskCaptures } from "./db/schema.ts";
import { SqliteTaskPluginDatabase } from "./db/task-plugins.ts";
import type { CommitTaskWrite } from "./interfaces/database.ts";
import type { TaskClassifier } from "./interfaces/task-classifier.ts";
import { plannerScopeHeader } from "./interfaces/notebook.ts";
import { plannerMcpHandler } from "./mcp/server.ts";
import { nutritionPlugin } from "./plugins/meal.ts";
import { mealEstimator } from "./plugins/meal-workflow.ts";
import type { EffectHandler } from "./interfaces/plugin-workflows.ts";
import { PluginReports } from "./core/plugin-reports.ts";
import { pluginReportRoutes } from "./routes/plugin-reports.ts";
import { chatRoutes } from "./routes/chats.ts";
import { imageRoutes } from "./routes/images.ts";
import { notebookRoutes } from "./routes/notebook.ts";
import { plannerApi } from "./routes/planner-api.ts";
import { plannerRoutes } from "./routes/tasks.ts";
import { taskSummaryRoutes } from "./routes/task-summaries.ts";
import { reviewRoutes, type PlannerCaller } from "./routes/review.ts";

export class UserPlanner extends DurableObject<Env> {
	private readonly store = drizzle(this.ctx.storage);
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => {
			await migratePlanner(this.store);
			this.plugins.workflows.migrate();
			// A cold start may precede delivery of an existing alarm or its platform retry.
			if ((await this.ctx.storage.getAlarm()) === null) {
				const due = this.nextDue();
				if (due !== null) await this.ctx.storage.setAlarm(due);
			}
		});
	}
	private readonly db = new SqlitePlannerDatabase(this.store);
	private readonly images = new PlannerImages(this.store, this.env.NOTEBOOK_IMAGES, this.ctx.id.toString());
	private readonly pluginDb = new SqliteTaskPluginDatabase(this.store);
	private readonly plugins = new TaskPlugins(
		this.db,
		this.pluginDb,
		[nutritionPlugin],
		undefined,
		this.createEffects(),
	);
	private readonly classifier = this.createClassifier();
	private readonly classification =
		this.classifier &&
		new TaskClassification(this.db, this.plugins, this.classifier, this.classificationBatchSize());
	private readonly planner = new Planner(this.db, (task, previous, rawInput) => {
		this.plugins.workflows.taskChanged(task, previous);
		if (task.title === previous?.title) return;
		if (previous)
			this.store
				.update(taskCaptures)
				.set({ currentInput: false })
				.where(eq(taskCaptures.taskId, task.id))
				.run();
		if (this.classification) this.classification.enqueue(task, Date.now(), rawInput);
		else if (previous) this.pluginDb.supersedeCaptureInput(task.id);
	});
	private readonly commitTaskWrite: CommitTaskWrite = async (write) => {
		return this.ctx.storage.transaction(async (txn) => {
			const armed = await txn.getAlarm();
			const previousDue = armed === null ? null : this.nextDue();
			const result = write();
			const due = this.nextDue();
			// An unrelated task edit must not pull forward a platform retry already in flight.
			if (due !== armed && (armed === null || due === null || due !== previousDue)) {
				if (due === null) await txn.deleteAlarm();
				else await txn.setAlarm(due);
			}
			return result;
		});
	};
	private readonly routes = plannerApi<PlannerCaller>()
		.route("/", reviewRoutes(new Review(this.store, this.planner), this.commitTaskWrite))
		.route("/", pluginReportRoutes(new PluginReports(this.plugins.workflows.reports, this.plugins)))
		.route("/", taskSummaryRoutes(new TaskSummaries(this.plugins)))
		.route(
			"/",
			plannerRoutes(this.planner, this.plugins, this.commitTaskWrite, this.classification),
		)
		.route("/", chatRoutes(this.store))
		.route(
			"/",
			notebookRoutes(new Notebook(this.store, this.planner, this.commitTaskWrite, this.plugins)),
		)
		.route("/", imageRoutes(this.images));
	private readonly mcp = plannerMcpHandler(async (request) =>
		this.routes.fetch(request, { fromAgent: true }),
	);

	protected createClassifier(): TaskClassifier | undefined {
		return this.env.AI ? ClefTaskClassifier.using(this.env.AI) : undefined;
	}

	protected createEffects(): ReadonlyMap<string, EffectHandler> {
		return new Map(this.env.AI ? [["nutrition.estimate", mealEstimator(this.env.AI, this.images)]] : []);
	}
	private nextDue() {
		const classify = this.classification ? this.pluginDb.nextDue() : null;
		const effect = this.plugins.workflows.db.nextDue();
		return classify === null ? effect : effect === null ? classify : Math.min(classify, effect);
	}

	private classificationBatchSize() {
		const size = Number(this.env.TASK_CLASSIFICATION_BATCH_SIZE);
		return Number.isInteger(size) && size >= 1 && size <= 64 ? size : 8;
	}

	async alarm() {
		const work: Promise<void>[] = [];
		if (this.classification && this.pluginDb.nextDue() !== null)
			work.push(this.classification.processDue(this.commitTaskWrite));
		if (this.plugins.workflows.db.nextDue() !== null)
			work.push(this.plugins.workflows.processDue(this.commitTaskWrite));
		await Promise.all(work);
	}

	hasSideChat(id: string) {
		return !!this.store
			.select({ id: sideChats.id })
			.from(sideChats)
			.where(eq(sideChats.id, id))
			.get();
	}

	async fetch(request: Request) {
		if (new URL(request.url).pathname === "/mcp") return this.mcp.fetch(request);
		const scope = this.ctx.id.toString();
		const expected = request.headers.get(plannerScopeHeader);
		if (expected !== null && expected !== scope) {
			return Response.json({ error: "This request belongs to a different planner. Reload to verify your account." }, {
				status: 412, headers: { "Cache-Control": "no-store" },
			});
		}
		const result = await this.routes.fetch(request);
		const response = new Response(result.body, result);
		response.headers.set(plannerScopeHeader, scope);
		return response;
	}
}
