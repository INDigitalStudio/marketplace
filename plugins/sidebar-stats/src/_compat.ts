/**
 * Compatibility layer for sidebar-stats (ported from Pi Sidebar by michaelmjhhhh).
 *
 * Re-exports what @oh-my-pi/pi-coding-agent provides, and stubs the symbols
 * it doesn't so the ported source compiles without the original
 * ../_compat.js package.
 */

// ── Re-exports from @oh-my-pi/pi-coding-agent (omp SDK) ──────────────────────

export { getAgentDir } from "@oh-my-pi/pi-coding-agent";

export type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ── Stubs for symbols not exported by @oh-my-pi/pi-coding-agent ───────────────

// CONFIG_DIR_NAME: omp uses .omp for project config, not .pi.
export const CONFIG_DIR_NAME = ".omp";

// estimateTokens: rough character-based approximation (original uses tiktoken)
// Accepts AgentMessage (object) or string — serializes if needed.
export function estimateTokens(message: unknown): number {
	let text: string;
	if (typeof message === "string") {
		text = message;
	} else if (message && typeof message === "object" && "content" in message) {
		const content = (message as { content: unknown }).content;
		if (Array.isArray(content)) {
			text = content.map((c: unknown) => {
				if (typeof c === "string") return c;
				if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text);
				return "";
			}).join("");
		} else {
			text = String(content);
		}
	} else {
		text = String(message ?? "");
	}
	return Math.round(text.length / 3.5);
}

// SettingsManager: sidebar calls .create(cwd).getCompactionSettings().enabled
// Safe default — compaction enabled is the normal omp behavior.
export class SettingsManager {
	static create(_cwd: string): SettingsManager {
		return new SettingsManager();
	}
	getCompactionSettings(): { enabled: boolean } {
		return { enabled: true };
	}
}

// CustomEditor: base editor class used by SidebarEditor in editor.ts.
// Publicly exported by @oh-my-pi/pi-coding-agent via src/index.ts:36 → modes/components → custom-editor.
export { CustomEditor } from "@oh-my-pi/pi-coding-agent";
// getSettingsListTheme: theme for SettingsList TUI component.
// Returns no-op theme functions matching SettingsListTheme interface.
export function getSettingsListTheme() {
	return {
		label: (s: string) => s,
		value: (s: string) => s,
		description: (s: string) => s,
		cursor: "▶",
		hint: (s: string) => s,
	};
}

// ── Re-exports from @earendil-works/pi-tui ───────────────────────────────────
// Bypass omp-legacy-pi-bundled alias by re-exporting everything from the real package.
export * from "../node_modules/@earendil-works/pi-tui/dist/index.js";
// OverlayFocusOwner: re-exported from @oh-my-pi/pi-tui (the RUNTIME TUI).
// @earendil-works/pi-tui doesn't have this interface, but omp's runtime TUI does.
// The sidebar component implements it so setFocus() accepts the editor as a
// valid focus target within the overlay, preventing input stealing.
export type { OverlayFocusOwner } from "@oh-my-pi/pi-tui";
