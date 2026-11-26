import type { ExtractionField, TitleExtractor } from "./clairic.ts";

export type TaskOutline = { title: string; children: string[] };

const headingFields: ExtractionField[] = [
  {
    path: "parent",
    modelKey: "parent_task",
    kind: "text",
    instructions: "Shared action verb or task heading, verbatim.",
  },
  {
    path: "body",
    modelKey: "checklist_body",
    kind: "text",
    instructions:
      "The exact span containing the items to do or subjects to work on. Start at the first item, after the shared action and any introductory words such as subtask. End at the last item. Return null unless there are multiple separately completable items.",
  },
];
const itemFields: ExtractionField[] = [
  {
    path: "children",
    modelKey: "items",
    kind: "text-list",
    instructions:
      "Extract every individual list item in order, verbatim. Preserve numeric labels, spelling and multiword items.",
  },
];

export async function extractSubtasks(
  extract: TitleExtractor | undefined,
  text: string,
): Promise<TaskOutline | undefined> {
  if (!extract) return;
  try {
    const { parent, body } = await extract(text, headingFields, AbortSignal.timeout(15_000));
    if (typeof parent !== "string" || typeof body !== "string") return;
    const title = parent.trim();
    if (
      !title ||
      title.length > 240 ||
      !text.includes(title) ||
      !body.trim() ||
      !text.includes(body)
    )
      return;
    const result = await extract(body, itemFields, AbortSignal.timeout(15_000));
    if (!Array.isArray(result.children)) return;
    const children = result.children.map((item) => item.trim());
    if (children.length < 2 || children.length > 100 || new Set(children).size !== children.length)
      return;
    let offset = 0;
    for (const child of children) {
      const start = body.indexOf(child, offset);
      if (!child || child.length > 240 || child === title || start < 0) return;
      offset = start + child.length;
    }
    return { title, children };
  } catch {
    console.warn(JSON.stringify({ event: "subtask_extraction_unavailable" }));
  }
}
