/**
 * Temporary local structural interfaces for the unreleased OMP side-pane API.
 * The plugin declares these so its current installed SDK can typecheck;
 * at runtime, feature-detection gates every call and fails closed.
 *
 * Remove this file when @oh-my-pi/pi-coding-agent publishes these types.
 */

// ── ExtensionSidePaneOptions ──────────────────────────────────────────────────

export interface ExtensionSidePaneOptions {
	/** Desired pane width in columns. Clamped to [minWidth, columns - minMainWidth]. */
	width: number;
	/** Minimum pane width; pane hides when terminal can't fit this. Default 20. */
	minWidth?: number;
	/** Minimum main-area width; pane hides when terminal can't fit main + pane. Default 60. */
	minMainWidth?: number;
}

// ── AgentProgress ─────────────────────────────────────────────────────────────

export interface AgentProgress {
	readonly index: number;
	readonly id: string;
	readonly agent: string;
	readonly agentSource: unknown;
	readonly status: "pending" | "running" | "completed" | "failed" | "aborted";
	readonly task: string;
	readonly assignment?: string;
	readonly description?: string;
	readonly lastIntent?: string;
	readonly currentTool?: string;
	readonly currentToolArgs?: string;
	readonly currentToolStartMs?: number;
	readonly recentTools: ReadonlyArray<{
		readonly tool: string;
		readonly args: string;
		readonly endMs: number;
	}>;
	readonly recentOutput: readonly string[];
	readonly toolCount: number;
	readonly requests: number;
	readonly tokens: number;
	readonly contextTokens?: number;
	readonly contextWindow?: number;
	readonly cost: number;
	readonly durationMs: number;
	readonly modelOverride?: string | readonly string[];
	readonly modelRole?: string;
	readonly resolvedModel?: string;
	readonly resolvedModelIsFallback?: boolean;
	readonly extractedToolData?: Readonly<Record<string, unknown[]>>;
	readonly retryState?: {
		readonly attempt: number;
		readonly maxAttempts: number;
		readonly delayMs: number;
		readonly errorMessage: string;
		readonly startedAtMs: number;
	};
	readonly retryFailure?: { readonly attempt: number; readonly errorMessage: string };
	readonly inflightTaskDetails?: unknown;
}

// ── ExtensionAgentSession ─────────────────────────────────────────────────────

export interface ExtensionAgentSession {
	readonly id: string;
	readonly kind: "main" | "subagent";
	readonly label: string;
	readonly agent?: string;
	readonly description?: string;
	readonly status: "active" | "completed" | "failed" | "aborted";
	readonly sessionFile?: string;
	readonly parentToolCallId?: string;
	readonly detached?: boolean;
	readonly index?: number;
	readonly lastUpdate: number;
	readonly progress?: AgentProgress;
}

// ── SidePaneComponentFactory ──────────────────────────────────────────────────

/**
 * Matches the real ExtensionUiComponentFactory from the omp SDK:
 *   (tui: TUI, theme: Theme) => ExtensionUiComponent
 * where ExtensionUiComponent = Component & { dispose?(): void }
 *
 * Declared with `unknown` params so this file compiles without importing
 * the unreleased setSidePane symbol from the SDK.
 */
export type SidePaneComponentFactory = (
	tui: unknown,
	theme: unknown,
) => { render(width: number): string[]; invalidate(): void; dispose?(): void };

// ── Feature detection ─────────────────────────────────────────────────────────

/** Shape of ctx.ui when the side-pane API is available. */
export interface SidePaneCapableUI {
	setSidePane(key: string, content: SidePaneComponentFactory | undefined, options?: ExtensionSidePaneOptions): void;
	onAgentSessionsChange(handler: (sessions: readonly ExtensionAgentSession[]) => void): () => void;
}

const MINIMUM_OMP_VERSION_HINT = "an OMP build newer than 18.1.7 with the setSidePane API";

/**
 * Returns a narrow view of ctx.ui if the setSidePane API is present,
 * or undefined with a notification if not. Fails closed.
 */
export function getSidePaneUI(ui: {
	setSidePane?: unknown;
	onAgentSessionsChange?: unknown;
	notify?: (msg: string, level: string) => void;
}): SidePaneCapableUI | undefined {
	if (typeof ui.setSidePane === "function" && typeof ui.onAgentSessionsChange === "function") {
		return ui as unknown as SidePaneCapableUI;
	}
	try {
		ui.notify?.(`Sidebar Stats requires ${MINIMUM_OMP_VERSION_HINT}; the sidebar is disabled.`, "warning");
	} catch {
		// Notification is best-effort.
	}
	return undefined;
}
