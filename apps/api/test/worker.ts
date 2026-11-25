// The Worker under test mounts the app's Durable Objects directly, without Flue's build output.
import { UserPlanner as Planner } from "../src/user-planner.ts";
import type { EffectHandler } from "../src/interfaces/plugin-workflows.ts";
import type { TaskClassifier } from "../src/interfaces/task-classifier.ts";

export class UserPlanner extends Planner {
	protected override createEffects(): ReadonlyMap<string, EffectHandler> {
		const kv = this.ctx.storage.kv;
		if (!kv.get("test:meal-effects")) return super.createEffects();
		return new Map([["nutrition.estimate", async (input, signal) => {
			kv.put("test:estimate-calls", (kv.get<number>("test:estimate-calls") ?? 0) + 1);
			kv.put("test:estimate-input", input);
			while (kv.get("test:estimator") === "hold") await scheduler.wait(10, { signal });
			if (kv.get("test:estimator") === "fail") throw new Error("Estimator unavailable");
			return { calories: 408, proteinGrams: 24, carbohydrateGrams: 45, fatGrams: 14 };
		}]]);
	}

	protected override createClassifier(): TaskClassifier | undefined {
		if (this.ctx.storage.kv.get("test:no-classifier")) return;
		return {
			classify: async (inputs, signal) => {
				// Integration tests can hold or fail the provider in one isolated planner.
				const kv = this.ctx.storage.kv;
				if (kv.get("test:provider")) {
					kv.put("test:calls", (kv.get<number>("test:calls") ?? 0) + 1);
					while (kv.get("test:provider") === "hold") await scheduler.wait(10, { signal });
					if (kv.get("test:provider") === "fail") throw new Error("Test provider unavailable");
				}
				return inputs.map(({ taskId, title, candidates }) => ({
					taskId,
					scores: Object.fromEntries(
						candidates.map(({ typeId }) => [
							typeId,
							title.includes("Get dinner at Nuri Village") ? 0.99 : 0.1,
						]),
					),
				}));
			},
		};
	}
}

export { default } from "../src/app.ts";
