import { execFileSync } from "node:child_process";
import { ClefTaskClassifier } from "../src/classifiers/clef.ts";
import { classificationThreshold } from "../src/interfaces/task-classifier.ts";
import { mealType } from "../src/plugins/meal.ts";

// Synthetic planner entries. Each label says whether the author is having a meal.
const cases = [
	["late brunch", true],
	["cancel brunch", false],
	["ramen with my sister", true],
	["bring my sister her ramen", false],
	["reserve a table for four", false],
	["grab a bite after practice", true],
	["replace the broken lunchbox", false],
	["had a burrito before the train", true],
	["buy salmon for dinner", false],
	["team lunch at noon", true],
	["pizza night at home", true],
	["drive the team to lunch and head back", false],
	["ate leftover curry last night", true],
	["send the dinner invitation", false],
	["walk the dog", false],
	["dinner with a friend", true],
	["dumplings with the neighbors", true],
	["get dumplings for the neighbors on my way home", false],
	["staff breakfast on Friday", true],
	["print the breakfast menus", false],
	["change a restaurant booking", false],
	["had eggs and toast this morning", true],
	["supper at home", true],
	["sweep the kitchen", false],
];

const classifier = ClefTaskClassifier.using({
	run(model, payload) {
		return new Response(
			execFileSync("cf", ["ai", "run", model, "--body", JSON.stringify(payload)], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "inherit"],
			}),
		);
	},
});
const { instructions } = mealType.classification;
const candidates = [{ typeId: mealType.id, instructions }];
const results = [];
for (const [title, expected] of cases) {
	const [result] = await classifier.classify([{ taskId: title, title, candidates }]);
	const score = result.scores[mealType.id];
	results.push({ title, expected, score, matched: score > classificationThreshold });
}
console.table(results);
const misses = results.filter((row) => row.expected && !row.matched).length;
const falsePositives = results.filter((row) => !row.expected && row.matched).length;
console.log(
	`${results.length - misses - falsePositives}/${results.length} correct with score > ${classificationThreshold} (${misses} missed meals, ${falsePositives} false positives)`,
);
