import { z } from "zod";
import { runJsonModel, type PlannerAiBinding } from "../workers-ai.ts";
import type { TaskClassificationInput, TaskClassifier } from "../interfaces/task-classifier.ts";

const model = "@cf/cloudflare/clef-flash";
const maxQuestions = 64;
const scores = z.object({
	answers: z.record(z.string(), z.object({ noul: z.number().min(0).max(1) })),
});

type DecisionRequest = {
	model: "clef-flash";
	state: string;
	questions: Record<string, { type: "noul"; instructions: string }>;
};

export class ClefTaskClassifier implements TaskClassifier {
	private readonly run: (input: DecisionRequest, signal?: AbortSignal) => Promise<unknown>;

	constructor(run: (input: DecisionRequest, signal?: AbortSignal) => Promise<unknown>) {
		this.run = run;
	}

	static using(ai: PlannerAiBinding) {
		return new ClefTaskClassifier((input, signal) => runJsonModel(ai, model, input, signal));
	}

	async classify(inputs: readonly TaskClassificationInput[], signal?: AbortSignal) {
		const attempts = await Promise.allSettled(
			inputs.map((input) => this.classifyTask(input, signal)),
		);
		const completed = attempts.flatMap((attempt) =>
			attempt.status === "fulfilled" ? [attempt.value] : [],
		);
		if (completed.length === 0 && attempts[0]?.status === "rejected") throw attempts[0].reason;
		if (completed.length < inputs.length) {
			// An omitted task is retried by its own queue job.
			console.warn(
				JSON.stringify({
					event: "task_classification_provider_error",
					count: inputs.length - completed.length,
				}),
			);
		}
		return completed;
	}

	private async classifyTask(
		{ taskId, title, candidates }: TaskClassificationInput,
		signal?: AbortSignal,
	) {
		const result: Record<string, number> = {};
		for (let start = 0; start < candidates.length; start += maxQuestions) {
			signal?.throwIfAborted();
			const chunk = candidates.slice(start, start + maxQuestions);
			const questions: DecisionRequest["questions"] = Object.fromEntries(
				chunk.map(({ instructions }, i) => ["q" + i, { type: "noul", instructions }]),
			);
			const { answers } = scores.parse(
				await this.run({ model: "clef-flash", state: title, questions }, signal),
			);
			for (const [i, candidate] of chunk.entries()) {
				const answer = answers["q" + i];
				if (!answer) throw new Error("Clef omitted a task classification answer");
				result[candidate.typeId] = answer.noul;
			}
		}
		return { taskId, scores: result };
	}
}
