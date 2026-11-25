import { z } from "zod";
import type { TaskPlugin, TaskSubtypeDefinition } from "../interfaces/task-plugins.ts";

const nutrition = z.strictObject({
	calories: z.number().nonnegative(),
	proteinGrams: z.number().nonnegative(),
});
const maxFoods = 30;
const maxFoodLength = 200;
const mealData = z.strictObject({
	foods: z.array(z.string().trim().min(1).max(maxFoodLength)).max(maxFoods).optional(),
	estimatedNutrition: nutrition.optional(),
});

export type NutritionInfo = z.infer<typeof nutrition>;
export interface Meal {
	taskId: string;
	foods(): readonly string[] | undefined;
	nutrition(): NutritionInfo | undefined;
}

export const mealType: TaskSubtypeDefinition<z.infer<typeof mealData>, Meal> = {
	id: "nutrition.meal",
	label: "Meal",
	icon: "utensils",
	captureCommand: "meal",
	schemaVersion: 1,
	schema: mealData,
	initialData: {},
	prompts: [{ id: "foods", field: "foods", label: "What did you eat?", trigger: "task.completed" }],
	editor: [
		{
			fields: [
				{
					key: "foods",
					label: "What did you eat?",
					inlayLabel: "Foods",
					kind: "text-list",
					maxItems: maxFoods,
					maxLength: maxFoodLength,
				},
			],
		},
		{
			key: "estimatedNutrition",
			label: "Estimated nutrition",
			requiredTogether: true,
			fields: [
				{ key: "calories", label: "Calories (kcal)", kind: "number", min: 0 },
				{ key: "proteinGrams", label: "Protein (g)", kind: "number", min: 0 },
			],
		},
	],
	classification: {
		instructions:
			"Does the task describe the user having a meal? Count planned or past meals. Calendar shorthand counts: brunch, dinner with friends, meeting for noodles, grabbing a bite, or curry night. Exclude errands such as reserving a table, buying ingredients, delivering food to someone else, or picking someone up after dinner.",
		threshold: 0.85,
	},
	view: (task, data) => ({
		taskId: task.id,
		foods: () => data.foods,
		nutrition: () => data.estimatedNutrition,
	}),
};

export const nutritionPlugin: TaskPlugin = {
	id: "nutrition",
	label: "Nutrition",
	subtypes: [mealType],
	facts: [{ id: "nutrition.logged-meal", version: 1, scopes: ["local-day"] }],
};
