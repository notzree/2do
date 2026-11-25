import { expect, it } from "vite-plus/test";
import type { TaskSubtypeEditor } from "@2do/api/task-plugins";
import { readFields, writeFields } from "./subtype-fields.ts";

const editor: TaskSubtypeEditor = [
  { fields: [{ key: "foods", label: "Food", kind: "text-list", maxItems: 2, maxLength: 20 }] },
  {
    key: "estimatedNutrition",
    requiredTogether: true,
    fields: [
      { key: "calories", label: "Calories", kind: "number", min: 0 },
      { key: "proteinGrams", label: "Protein", kind: "number", min: 0 },
    ],
  },
];

it("loads saved fields and serializes typed values without discarding other data", () => {
  const data = {
    foods: ["Bibimbap"],
    estimatedNutrition: { calories: 600, proteinGrams: 25 },
    note: "Keep",
  };
  const fields = readFields(editor, data);
  expect(fields).toEqual({
    foods: "Bibimbap",
    "estimatedNutrition.calories": "600",
    "estimatedNutrition.proteinGrams": "25",
  });
  expect(writeFields(editor, data, { ...fields, foods: "Bibimbap\n\n Kimchi " })).toEqual({
    ...data,
    foods: ["Bibimbap", "Kimchi"],
  });
  expect(writeFields(editor, data, { foods: "Bibimbap" })).toEqual({
    foods: ["Bibimbap"],
    note: "Keep",
  });
});

it("validates editable groups and retains zero as a known value", () => {
  expect(() => writeFields(editor, {}, { "estimatedNutrition.calories": "0" })).toThrow(
    "Enter protein.",
  );
  expect(() => writeFields(editor, {}, { foods: "A\nB\nC" })).toThrow("Enter up to 2 items");
  expect(
    writeFields(
      editor,
      {},
      {
        "estimatedNutrition.calories": "0",
        "estimatedNutrition.proteinGrams": "0",
      },
    ),
  ).toEqual({ estimatedNutrition: { calories: 0, proteinGrams: 0 } });
});
