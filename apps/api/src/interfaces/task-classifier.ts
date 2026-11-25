export interface ClassificationCandidate {
	typeId: string;
	instructions: string;
}

export interface TaskClassificationInput {
	taskId: string;
	title: string;
	candidates: readonly ClassificationCandidate[];
}

export interface TaskClassificationResult {
	taskId: string;
	/** One finite probability in [0, 1] for each requested candidate. */
	scores: Readonly<Record<string, number>>;
}

export interface TaskClassifier {
	/** Stop external work on abort. A missing result leaves that task eligible for retry. */
	classify(
		inputs: readonly TaskClassificationInput[],
		signal?: AbortSignal,
	): Promise<readonly TaskClassificationResult[]>;
}
