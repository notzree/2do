import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClefTaskClassifier } from "../src/classifiers/clef.ts";
import { classificationThreshold } from "../src/interfaces/task-classifier.ts";
import { fitnessPlugin } from "../src/plugins/fitness.ts";
import { nutritionPlugin } from "../src/plugins/meal.ts";
import { budgetingPlugin } from "../src/plugins/budgeting.ts";
import { productivityPlugin } from "../src/plugins/productivity.ts";

const exec = promisify(execFile);
const classifier = ClefTaskClassifier.using({
  async run(model, payload) {
    const { stdout } = await exec("cf", ["ai", "run", model, "--body", JSON.stringify(payload)]);
    return JSON.parse(stdout);
  },
});
const all = [nutritionPlugin, fitnessPlugin, budgetingPlugin, productivityPlugin];
const cases = [
  ["Pay CAD 18.50 for lunch at Nuri", "budgeting.expense"],
  ["Paid CAD 18.50 for lunch at Nuri", "budgeting.expense"],
  ["Run 5 km on Friday morning", "fitness.activity"],
  ["Pickup basketball at the gym", "fitness.activity"],
  ["Dinner with a friend at noon", "nutrition.meal"],
  ["Study indexing for ECE 356 for 45 minutes", "productivity.work-session"],
  ["Submit the design report by Friday at 5pm", "productivity.deadline"],
  ["Pick up my keys", null],
  ["Watch a basketball game on TV", null],
  ["Plan a 30-minute run", "fitness.activity", [fitnessPlugin]],
  ["Pay the electricity bill", "budgeting.expense", [budgetingPlugin]],
  ["Write the proposal from 2 to 3pm", "productivity.work-session", [productivityPlugin]],
  ["Lunch with a friend", "nutrition.meal", [nutritionPlugin]],
  [
    "Draft the architecture notes from 9am to noon",
    "productivity.work-session",
    [productivityPlugin],
  ],
  ["Mail the keys back", null, [productivityPlugin]],
  ["Run 5 km", null, [budgetingPlugin, productivityPlugin, nutritionPlugin]],
];
let correct = 0;
for (const [title, expected, plugins = all] of cases) {
  const candidates = plugins.flatMap((p) =>
    p.subtypes.map((s) => ({ typeId: s.id, instructions: s.classification.instructions })),
  );
  const [result] = await classifier.classify([{ taskId: "example", title, candidates }]);
  let best = classificationThreshold,
    winner = null;
  for (const { typeId } of candidates)
    if (result.scores[typeId] > best) {
      best = result.scores[typeId];
      winner = typeId;
    }
  if (winner === expected) correct++;
  console.log(JSON.stringify({ title, expected, winner, scores: result.scores }));
}
console.log(correct + "/" + cases.length + " correct");
if (correct !== cases.length) process.exitCode = 1;
