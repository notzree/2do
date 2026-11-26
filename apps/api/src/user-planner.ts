import { Carryover } from "./core/carryover.ts";
import { carryoverRoutes } from "./routes/carryover.ts";
import { PlannerGoals } from "./core/goals.ts";
import { GoalDatabase } from "./db/goals.ts";
import { goalRoutes } from "./routes/goals.ts";
import { clairicExtractor, type TitleExtractor } from "./extractors/clairic.ts";
import { ExtractionQueue } from "./db/subtype-extraction.ts";
import { SubtypeExtraction } from "./core/subtype-extraction.ts";
import { DurableObject } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/durable-sqlite";
import { migratePlanner } from "./db/migrate.ts";
import { ClefTaskClassifier } from "./classifiers/clef.ts";
import { Notebook } from "./core/notebook.ts";
import { PlannerCalendars, type ExportResult } from "./core/calendar-sync.ts";
import type { Task } from "./interfaces/plan.ts";
import type { CalendarEvent } from "./interfaces/connectors.ts";
import { Planner, PlannerError } from "./core/planner.ts";
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
import { budgetingPlugin } from "./plugins/budgeting.ts";
import { fitnessPlugin } from "./plugins/fitness.ts";
import { productivityPlugin } from "./plugins/productivity.ts";
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

const calendarDeleteRequest = "calendar:delete:";
const calendarDeletionLock = "calendar:deleting:";

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
		[nutritionPlugin, fitnessPlugin, budgetingPlugin, productivityPlugin],
		undefined,
		this.createEffects(),
		(task, definition, subtype, text) => this.extraction?.enqueue(task, definition, subtype, text),
	);
	private readonly extractor = this.createExtractor();
	private readonly extraction: SubtypeExtraction | undefined = this.extractor &&
		new SubtypeExtraction(new ExtractionQueue(this.store), this.db, this.plugins, this.extractor);
	private readonly classifier = this.createClassifier();
	private readonly classification =
		this.classifier &&
		new TaskClassification(this.db, this.plugins, this.classifier, this.classificationBatchSize());
	private readonly planner = new Planner(this.db, (task, previous, rawInput) => {
		if (previous) this.guardCalendarDeletion(task.id);
		this.calendars.guard(task, previous);
		this.plugins.workflows.taskChanged(task, previous);
		if (this.calendars.processingImport) return;
		if (task.title === previous?.title) return;
		if (previous) this.extraction?.queue.cancelTask(task.id);
		if (previous)
			this.store
				.update(taskCaptures)
				.set({ currentInput: false })
				.where(eq(taskCaptures.taskId, task.id))
				.run();
		if (this.classification) this.classification.enqueue(task, Date.now(), rawInput);
		else if (previous) this.pluginDb.supersedeCaptureInput(task.id);
	}, (id) => {
		const capture = id && this.store.select().from(taskCaptures).where(eq(taskCaptures.taskId, id)).get();
		return (capture && capture.document.timeZone) || this.pluginDb.reports.timeZone();
	}, (id) => this.guardCalendarDeletion(id));
	private readonly calendars: PlannerCalendars = new PlannerCalendars(this.store, this.planner);

	private guardCalendarDeletion(id: string) {
		if (this.ctx.storage.kv.get<number>(calendarDeletionLock + id) !== undefined)
			throw new PlannerError(409, "This event is being deleted from 2do and Google Calendar.");
	}

	calendarLinkStatus(id: string) {
		return this.calendars.status(id);
	}
	async publishCalendar(id: string, account: string, enabled: boolean) {
		try {
			await this.commitTaskWrite(() => {
				const link = this.calendars.link(id);
				this.calendars.publish(id, account, enabled);
				if (link && !enabled) {
					this.ctx.storage.kv.delete(calendarDeleteRequest + link.remoteId);
					this.ctx.storage.kv.delete(calendarDeletionLock + id);
				}
			});
			return true;
		} catch (error) {
			if (error instanceof PlannerError) return false;
			throw error;
		}
	}
	async importCalendar(account: string, generation: string, events: CalendarEvent[]) {
		await this.commitTaskWrite(() => this.calendars.importPage(account, generation, events));
	}
	finishCalendarImport(account: string, generation: string) {
		return this.commitTaskWrite(() => this.calendars.finishImport(account, generation));
	}
	async cancelCalendarDeletions() {
		await this.commitTaskWrite(() => {
			for (const prefix of [calendarDeleteRequest, calendarDeletionLock])
				for (const [key] of this.ctx.storage.kv.list({ prefix })) this.ctx.storage.kv.delete(key);
		});
	}
	async requestCalendarDeletion(id: string, account: string, revision: number) {
		return this.commitTaskWrite(() => {
			const link = this.calendars.link(id);
			if (!link?.base || link.account !== account || link.origin !== "planner" || this.db.task(id)?.revision !== revision)
				return false;
			this.ctx.storage.kv.put(calendarDeleteRequest + link.remoteId, revision);
			return true;
		});
	}
	async beginCalendarDeletion(id: string, remoteId: string, revision: number) {
		return this.commitTaskWrite(() => {
			if (this.calendars.link(id)?.remoteId !== remoteId ||
				this.ctx.storage.kv.get<number>(calendarDeleteRequest + remoteId) !== revision ||
				this.db.task(id)?.revision !== revision) return false;
			// Keep the revision stable across the Google DELETE and any retry after a lost response.
			this.ctx.storage.kv.put(calendarDeletionLock + id, revision);
			return true;
		});
	}
	calendarExports(account: string, after: string) {
		return this.calendars.exportPage(account, after).map(row => ({
			...row, deleteRevision: this.ctx.storage.kv.get<number>(calendarDeleteRequest + row.link.remoteId),
		}));
	}
	async finishCalendarExport(id: string, remoteId: string, before: Task | null, result: ExportResult) {
		await this.commitTaskWrite(() => {
			if (this.calendars.link(id)?.remoteId !== remoteId) return;
			if (result.kind === "deleted" &&
				(!before || this.ctx.storage.kv.get<number>(calendarDeletionLock + id) !== before.revision))
				throw new PlannerError(409, "The calendar deletion is no longer reserved.");
			this.ctx.storage.kv.delete(calendarDeletionLock + id);
			this.calendars.settle(id, remoteId, before, result);
			this.ctx.storage.kv.delete(calendarDeleteRequest + remoteId);
		});
	}
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
	private readonly carryover = new Carryover(this.store, this.planner, this.ctx.storage.kv, () => this.pluginDb.reports.timeZone());
	private readonly goals = new PlannerGoals(new GoalDatabase(this.store),this.db,this.plugins);
	private readonly routes = plannerApi<PlannerCaller>()
		.route("/", carryoverRoutes(this.carryover, this.commitTaskWrite))
		.route("/", goalRoutes(this.goals))
		.route("/", reviewRoutes(new Review(this.store, this.planner), this.commitTaskWrite))
		.route("/", pluginReportRoutes(new PluginReports(this.plugins.workflows.reports, this.plugins)))
		.route("/", taskSummaryRoutes(new TaskSummaries(this.plugins)))
		.route(
			"/",
			plannerRoutes(this.planner, this.plugins, this.commitTaskWrite, this.classification, (id) => this.calendars.status(id), this.extractor),
		)
		.route("/", chatRoutes(this.store))
		.route(
			"/",
			notebookRoutes(new Notebook(this.store, this.planner, this.commitTaskWrite, this.plugins, this.goals, this.extractor)),
		)
		.route("/", imageRoutes(this.images));
	private readonly mcp = plannerMcpHandler(async (request) =>
		this.routes.fetch(request, { fromAgent: true }),
	);

	protected createExtractor(): TitleExtractor | undefined {
		return this.env.AI ? clairicExtractor(this.env.AI) : undefined;
	}

	protected createClassifier(): TaskClassifier | undefined {
		return this.env.AI ? ClefTaskClassifier.using(this.env.AI) : undefined;
	}

	protected createEffects(): ReadonlyMap<string, EffectHandler> {
		return new Map(this.env.AI ? [["nutrition.estimate", mealEstimator(this.env.AI, this.images)]] : []);
	}
	private nextDue() {
		const classify = this.classification ? this.pluginDb.nextDue() : null;
		const effect = this.plugins.workflows.db.nextDue();
		const due = [classify, effect, this.carryover.nextDue(), this.extraction?.queue.nextDue()].filter((time): time is number => time != null);
		return due.length ? Math.min(...due) : null;
	}

	private classificationBatchSize() {
		const size = Number(this.env.TASK_CLASSIFICATION_BATCH_SIZE);
		return Number.isInteger(size) && size >= 1 && size <= 64 ? size : 8;
	}

	async alarm() {
		const work: Promise<void>[] = [];
		if (this.carryover.nextDue() !== null)
			work.push(this.commitTaskWrite(() => this.carryover.processDue()));
		if (this.classification && this.pluginDb.nextDue() !== null)
			work.push(this.classification.processDue(this.commitTaskWrite));
		if (this.plugins.workflows.db.nextDue() !== null)
			work.push(this.plugins.workflows.processDue(this.commitTaskWrite));
		if (this.extraction && this.extraction.queue.nextDue() !== null)
			work.push(this.extraction.processDue(this.commitTaskWrite));
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
