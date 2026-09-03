/**
 * Compatibility layer for sidebar-stats (ported from Pi Atelier by michaelmjhhhh).
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
export function estimateTokens(text: string): number {
	return Math.round(text.length / 3.5);
}

// SettingsManager: atelier calls .create(cwd).getCompactionSettings().enabled
// Safe default — compaction enabled is the normal omp behavior.
export class SettingsManager {
	static create(_cwd: string): SettingsManager {
		return new SettingsManager();
	}
	getCompactionSettings(): { enabled: boolean } {
		return { enabled: true };
	}
}

// CustomEditor: base editor class used by AtelierEditor in editor.ts.
// Publicly exported by @oh-my-pi/pi-coding-agent via src/index.ts:36 → modes/components → custom-editor.
export { CustomEditor } from "@oh-my-pi/pi-coding-agent";
// getSettingsListTheme: theme for SettingsList TUI component.
// Omp has no equivalent; return empty theme (SettingsList uses defaults).
export function getSettingsListTheme(): Record<string, string> {
	return {};
}

// ── Re-exports from @earendil-works/pi-tui ───────────────────────────────────
// Bypass omp-legacy-pi-bundled alias by re-exporting everything from the real package.
export * from "../node_modules/@earendil-works/pi-tui/dist/index.js";
