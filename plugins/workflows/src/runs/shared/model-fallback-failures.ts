/**
 * Compatibility exports for the shared Atomic model-failure classifier.
 *
 * The implementation lives in @bastani/atomic so the main chat, workflows,
 * and subagents cannot drift into separate fallback decisions.
 */

export type {
	ModelFallbackFailureKind,
	ModelFallbackFailureSignal,
	ModelFallbackFailureSource,
} from "../../_compat.js";
export {
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	modelFailureMessage,
	normalizeModelFailureSignal,
} from "../../_compat.js";
