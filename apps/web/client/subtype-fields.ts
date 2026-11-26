import {
  fieldName,
  fieldGroupData,
  readEditorValue,
  type TaskSubtype,
  type TaskSubtypeEditor,
} from "@2do/api/task-plugins";

type Data = NonNullable<TaskSubtype["data"]>;
export type FieldValues = Record<string, string>;

export { fieldName };

export function readFields(editor: TaskSubtypeEditor, data: Data): FieldValues {
  return Object.fromEntries(
    editor.flatMap((group) =>
      group.fields.map((field) => {
        const value = readEditorValue(data, group, field);
        const text = Array.isArray(value)
          ? value.join("\n")
          : value === undefined
            ? ""
            : String(value);
        return [fieldName(group, field), text];
      }),
    ),
  );
}

export function writeFields(editor: TaskSubtypeEditor, data: Data, values: FieldValues): Data {
  const updated = { ...data };
  for (const group of editor) {
    const target = group.key ? { ...fieldGroupData(data, group.key) } : updated;
    const populated = group.fields.some((field) => !!values[fieldName(group, field)]?.trim());
    for (const field of group.fields) {
      const text = values[fieldName(group, field)]?.trim() ?? "";
      if (field.kind === "text-list") {
        const items = text
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        if (items.length > field.maxItems || items.some((item) => item.length > field.maxLength)) {
          throw new Error(
            `Enter up to ${field.maxItems} items, each at most ${field.maxLength} characters.`,
          );
        }
        if (items.length) target[field.key] = items;
        else delete target[field.key];
      } else if (text && (field.kind === "text" || field.kind === "choice")) {
        if (field.kind === "text" ? text.length > field.maxLength : !field.options.includes(text))
          throw new Error("Invalid " + field.label);
        target[field.key] = text;
      } else if (text && field.kind === "number") {
        const number = Number(text);
        if (!Number.isFinite(number) || number < field.min) {
          throw new Error(`${field.label} must be at least ${field.min}.`);
        }
        target[field.key] = number;
      } else {
        if (group.requiredTogether && populated)
          throw new Error("Enter " + field.label.toLowerCase() + ".");
        delete target[field.key];
      }
    }
    if (group.key) {
      if (Object.keys(target).length) updated[group.key] = target;
      else delete updated[group.key];
    }
  }
  return updated;
}
