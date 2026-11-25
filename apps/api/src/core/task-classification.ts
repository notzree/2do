import type { ClassificationJob } from "../db/task-plugins.ts";
import type { CommitTaskWrite, PlannerDatabase } from "../interfaces/database.ts";
import type { Task } from "../interfaces/plan.ts";
import type { TaskClassifier } from "../interfaces/task-classifier.ts";
import type { TaskPlugins } from "./task-plugins.ts";
import { PlannerError } from "./planner.ts";

const maxAttempts = 3;
const leaseTime = 60_000;
const batchWindow = 1_000;

type ClassificationRequest = {
	job: ClassificationJob;
	title: string | undefined;
	candidates: ReturnType<TaskPlugins["enabledTypes"]>;
};

export class TaskClassification {
	constructor(
		private readonly planner: Pick<PlannerDatabase, "task">,
		private readonly plugins: TaskPlugins,
		private readonly classifier: TaskClassifier,
		private readonly batchSize = 8,
	) {}

	enqueue(task: Task, now = Date.now(), rawInput?: string) {
		if (this.plugins.enabledTypes().length === 0) {
			this.plugins.db.supersedeCaptureInput(task.id, now);
			return;
		}
		const due = this.batchSize === 1 ? now : (Math.floor(now / batchWindow) + 1) * batchWindow;
		this.plugins.db.enqueue(task.id, due, rawInput);
	}

	request(taskId: string) {
		if (!this.planner.task(taskId)) throw new PlannerError(404, "Task not found");
		const enabled = this.plugins.enabledTypes();
		if (!enabled.length) throw new PlannerError(409, "Enable a task plugin to classify this task.");
		const protectedTypes = this.plugins.protectedTypes(taskId);
		if (enabled.every(({ definition }) => protectedTypes.has(definition.id)))
			throw new PlannerError(409, "The enabled types have manual decisions or require a compatible version.");
		this.plugins.db.requestClassification(taskId, Date.now());
	}

	private claim(now: number): ClassificationRequest[] {
		const db = this.plugins.db;
		const jobs = db.claimDue(now, this.batchSize, now + leaseTime, maxAttempts);
		if (!jobs.length) return [];
		const enabled = this.plugins.enabledTypes();
		return jobs.map((job) => {
			const task = this.planner.task(job.taskId);
			const protectedTypes = this.plugins.protectedTypes(job.taskId);
			return {
				job,
				title: task?.title,
				candidates: task ? enabled.filter(({ definition }) => !protectedTypes.has(definition.id)) : [],
			};
		});
	}

	async processDue(commit: CommitTaskWrite, now = Date.now()) {
		// Commit the claim and its recovery alarm before starting external work.
		const requests = await commit(() => this.claim(now));
		if (!requests.length) return;
		const work = requests.flatMap(({ title, job, candidates }) =>
			title && candidates.length
				? [
						{
							taskId: job.taskId,
							// The persisted subtype still uses the display title as its validity check.
							title: job.rawInput ?? title,
							candidates: candidates.map(({ definition }) => ({
								typeId: definition.id,
								instructions: definition.classification.instructions,
							})),
						},
					]
				: [],
		);

		let results: ReadonlyMap<string, Readonly<Record<string, number>>>;
		try {
			const response = work.length
				? await this.classifier.classify(work, AbortSignal.timeout(leaseTime))
				: [];
			results = new Map(response.map(({ taskId, scores }) => [taskId, scores]));
		} catch {
			console.warn(
				JSON.stringify({ event: "task_classification_provider_error", count: work.length }),
			);
			results = new Map();
		}
		await commit(() => {
			const epochs = new Map(
				this.plugins.enabledTypes().map(({ definition, epoch }) => [definition.id, epoch]),
			);
			for (const request of requests)
				this.settle(request, results.get(request.job.taskId) ?? {}, epochs);
		});
	}

	private settle(
		{ job, title, candidates }: ClassificationRequest,
		scores: Readonly<Record<string, number>>,
		epochs: ReadonlyMap<string, string>,
	) {
		const db = this.plugins.db;
		const task = this.planner.task(job.taskId);
		if (!task || task.title !== title) {
			db.finish(job);
			return;
		}
		const existing = new Map(db.subtypes(task.id, title).map((s) => [s.typeId, s]));
		const protectedTypes = this.plugins.protectedTypes(task.id);
		const automatic = candidates.filter(({ definition }) => !protectedTypes.has(definition.id));
		const current = automatic.filter(
			({ definition, epoch }) => epochs.get(definition.id) === epoch,
		);
		if (
			current.some(({ definition }) => {
				const score = scores[definition.id];
				return !Number.isFinite(score) || score < 0 || score > 1;
			})
		) {
			this.retry(job);
			return;
		}
		// A newer title, a reclaimed lease or a recreated task owns a different token/attempt.
		if (!db.finish(job)) return;
		const decisions = current.map(({ definition, epoch }) => {
			const matched = scores[definition.id] >= definition.classification.threshold;
			if (!matched) this.plugins.removeAutomatic(task, definition.id);
			else if (!existing.has(definition.id))
				this.plugins.store(task.id, definition, "automatic", definition.initialData, title);
			return { typeId: definition.id, epoch, matched };
		});
		if (decisions.length)
			db.saveResult({ taskId: task.id, title, checkedAt: new Date().toISOString(), decisions });
		// A plugin re-enabled during this call needs an evaluation against its new install epoch.
		if (
			automatic.some(
				({ definition, epoch }) => epochs.has(definition.id) && epochs.get(definition.id) !== epoch,
			)
		)
			db.enqueue(task.id, Date.now(), job.rawInput ?? undefined);
	}

	private retry(job: ClassificationJob) {
		this.plugins.db.retry(
			job,
			job.attempts < maxAttempts ? Date.now() + 2_000 * job.attempts : null,
		);
	}
}
