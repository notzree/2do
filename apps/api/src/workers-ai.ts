// Clef and Clairic are available through the binding ahead of the generated model types.
type PlannerModels = AiModels & Record<
	"@cf/cloudflare/clef-flash" | "@cf/cloudflare/clairic",
	{ inputs: Record<string, unknown> }
>;

export interface PlannerAiBinding {
	run<Name extends keyof PlannerModels>(
		model: Name,
		input: PlannerModels[Name]["inputs"],
		options: { returnRawResponse: true; signal?: AbortSignal },
	): Promise<Response>;
}

export async function runJsonModel<Name extends keyof PlannerModels>(
	ai: PlannerAiBinding,
	model: Name,
	input: PlannerModels[NoInfer<Name>]["inputs"],
	signal?: AbortSignal,
): Promise<unknown> {
	// workerd reads the shared binding's latest response mode after awaiting inference.
	// Match Flue's raw mode so overlapping chat and planner calls both receive a Response.
	const response = await ai.run(model, input, { returnRawResponse: true, signal });
	if (!response.ok) {
		const detail = await response.text();
		throw new Error(`Workers AI ${model} returned HTTP ${response.status}: ${detail}`);
	}
	return response.json();
}
