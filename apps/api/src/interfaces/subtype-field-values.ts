// Both the wire editor and prompt descriptors support a top-level field or one nested group.
type Data = Record<string, unknown>;

export function fieldName(group: { key?: string }, field: { key: string }) {
	return group.key ? group.key + "." + field.key : field.key;
}

export function fieldGroupData(data: Data, groupKey?: string): Data | undefined {
	if (!groupKey) return data;
	const group = Object.hasOwn(data, groupKey) ? data[groupKey] : undefined;
	if (group && typeof group === "object" && !Array.isArray(group)) return group as Data;
}

export function readFieldValue(data: Data, path: string): unknown {
	const dot = path.indexOf(".");
	const group = dot < 0 ? data : fieldGroupData(data, path.slice(0, dot));
	const key = path.slice(dot + 1);
	return group && Object.hasOwn(group, key) ? group[key] : undefined;
}

export function readEditorValue(
	data: Data,
	group: { key?: string },
	field: { key: string; kind: "number" | "text-list" },
): string[] | number | undefined {
	const value = readFieldValue(data, fieldName(group, field));
	if (field.kind === "number") return typeof value === "number" && Number.isFinite(value) ? value : undefined;
	if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value;
}
