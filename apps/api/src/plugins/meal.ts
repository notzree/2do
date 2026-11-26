import { z } from "zod";
import type { TaskPlugin, TaskSubtypeDefinition } from "../interfaces/task-plugins.ts";

import {
	foods,
	mealData,
	mealWorkflow,
	nutrientFields,
	nutrition,
	nutritionMetrics,
} from "./meal-workflow.ts";

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
		{ fields: [foods.field] },
		{
			key: "estimatedNutrition",
			label: "Estimated nutrition",
			requiredTogether: true,
			fields: nutrientFields.slice(0, 2),
		},
	],
	workflow: mealWorkflow,
	extraction: {
		foods: "Foods or dishes the user plans to eat or ate. Return the food names exactly as written. If no foods are named, return an empty list. Exclude meal names, people, places, and times.",
	},
	classification: {
		instructions:
			"Does the task describe the user having a meal? Count planned or past meals. Calendar shorthand counts: brunch, dinner with friends, meeting for noodles, grabbing a bite, or curry night. Classify the main action. A payment or receipt mentioning lunch describes spending. Exclude those transactions and errands such as reserving a table, buying ingredients, delivering food to someone else, or picking someone up after dinner.",
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
	description: "Log meals, review nutrient estimates, and track daily nutrition goals.",
	metrics: nutritionMetrics,
	subtypes: [mealType],
	facts: [{ id: "nutrition.logged-meal", version: 1, scopes: ["local-day"] }],
};
