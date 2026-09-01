export function fold_usage(_stages: Array<{ stageName: string; text: string; modelAttempts: unknown }>) {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}
