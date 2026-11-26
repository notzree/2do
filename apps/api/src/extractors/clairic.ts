import { z } from "zod";

export type ExtractionField = {
  path: string;
  modelKey?: string;
  kind: "number" | "text-list" | "text" | "choice" | "date" | "time" | "duration" | "boolean";
  instructions: string;
};
export type TitleExtractor = (
  title: string,
  fields: ExtractionField[],
  signal: AbortSignal,
  referenceDate?: string,
) => Promise<Record<string, number | string | string[] | boolean>>;

const answer = z.object({
  value: z.unknown(),
  valid: z.boolean().optional(),
  complete: z.boolean().optional(),
});
const output = z.object({
  answers: z.record(z.string(), answer),
  truncated: z.boolean().optional(),
});

export function clairicExtractor(ai: Pick<Ai, "run">): TitleExtractor {
  return async (title, fields, signal, referenceDate) => {
    const specs = Object.fromEntries(
      fields.map(({ kind, instructions, modelKey }, i) => [
        modelKey ?? "f" + i,
        kind === "text-list"
          ? { type: "list", items: "text", instructions }
          : { type: kind === "choice" ? "text" : kind, instructions },
      ]),
    );
    const result = output.parse(
      await ai.run(
        "@cf/cloudflare/clairic",
        {
          model: "clairic",
          state: title,
          fields: specs,
          ...(referenceDate && { reference_date: referenceDate }),
        },
        { signal },
      ),
    );
    if (result.truncated) throw new Error("Incomplete title extraction");
    const values: Awaited<ReturnType<TitleExtractor>> = {};
    for (const [i, field] of fields.entries()) {
      const item = result.answers[field.modelKey ?? "f" + i];
      if (!item || item.valid === false || item.complete === false)
        throw new Error("Invalid title extraction");
      if (item.value == null) continue;
      if (field.kind === "number" || field.kind === "duration")
        values[field.path] = z.number().parse(item.value);
      else if (field.kind === "date" || field.kind === "time")
        values[field.path] = z.string().parse(item.value);
      else if (field.kind === "boolean") values[field.path] = z.boolean().parse(item.value);
      else if (field.kind === "text" || field.kind === "choice") {
        if (typeof item.value === "string" && item.value.trim() && title.includes(item.value))
          values[field.path] = item.value;
      } else {
        const items = z
          .array(z.string().min(1))
          .parse(item.value)
          .filter((text) => title.includes(text));
        if (items.length) values[field.path] = items;
      }
    }
    return values;
  };
}
