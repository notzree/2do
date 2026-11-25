// The Worker under test mounts the app's Durable Objects directly, without Flue's build output.
import { UserPlanner as Planner } from "../src/user-planner.ts";
import type { TaskClassifier } from "../src/interfaces/task-classifier.ts";

export class UserPlanner extends Planner {
	protected override createClassifier(): TaskClassifier {
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
