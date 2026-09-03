/**
 * Subagents panel: renders onAgentSessionsChange snapshots as sidebar rows.
 * Consumes OMP snapshots — no duplicate subagent registry or event-bus subscription.
 */

import { truncateToWidth, visibleWidth } from "./_compat.js";
import type { PaletteRole, SidebarPalette } from "./palette.js";
import { formatDuration } from "./run-activity.js";
import { sanitizeSidebarPanelText, SIDEBAR_PANEL_MAX_ROW_CHARS } from "./sidebar-panels.js";
import type { ExtensionAgentSession } from "./side-pane-api.js";

// ── Bounded sanitization ──────────────────────────────────────────────────────

const MAX_UNTRUSTED_CHARS = SIDEBAR_PANEL_MAX_ROW_CHARS;
const BOUNDED_SETTLED_ROWS = 32;
export const SETTLED_SUBAGENT_TTL_MS = 60_000;
function sanitize(text: string): string {
	return sanitizeSidebarPanelText(text, MAX_UNTRUSTED_CHARS);
}

function truncate(text: string, maxCols: number): string {
	return truncateToWidth(text, Math.max(0, maxCols), "…");
}

// ── Status helpers ────────────────────────────────────────────────────────────

function statusSymbol(status: ExtensionAgentSession["status"]): string {
	switch (status) {
		case "active":
			return "●";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "aborted":
			return "⊘";
	}
}

function statusRole(status: ExtensionAgentSession["status"]): PaletteRole {
	switch (status) {
		case "active":
			return "working";
		case "completed":
			return "ready";
		case "failed":
			return "error";
		case "aborted":
			return "dim";
	}
}

const kindLabel = (kind: ExtensionAgentSession["kind"]): string => (kind === "main" ? "main" : "sub");

// ── Summary row ───────────────────────────────────────────────────────────────

/** Single row: status, id/role, current tool or last intent, elapsed. */
function agentSummaryRow(
	session: ExtensionAgentSession,
	contentWidth: number,
	palette: SidebarPalette,
	now: number,
	expanded: boolean | undefined,
): string {
	const sym = statusSymbol(session.status);
	const role = statusRole(session.status);
	const kind = kindLabel(session.kind);
	const label = sanitize(session.label || session.id);

	const progress = session.progress;
	let detail = "";
	if (progress) {
		if (progress.currentTool) {
			detail = sanitize(progress.currentTool);
		} else if (progress.lastIntent) {
			detail = sanitize(progress.lastIntent);
		}
	}

	const elapsedMs = progress?.durationMs ?? now - session.lastUpdate;
	const elapsed = formatDuration(Math.max(0, elapsedMs));

	const right = palette.paint("muted", elapsed);
	const disclosure = expanded === undefined ? " " : expanded ? "▾" : "▸";
	const left = `${palette.paint("dim", disclosure)} ${palette.paint(role, sym)} ${kind}:${truncate(label, Math.max(1, contentWidth - elapsed.length - kind.length - 7))}`;
	const detailWidth = Math.max(0, contentWidth - visibleWidth(left) - visibleWidth(right) - 2);
	const middle = detailWidth > 0 && detail ? ` ${truncate(detail, detailWidth)} ` : "  ";
	return truncateToWidth(`${left}${middle}${right}`, contentWidth, "");
}

// ── Expanded detail rows ──────────────────────────────────────────────────────

function agentDetailRows(
	session: ExtensionAgentSession,
	contentWidth: number,
	palette: SidebarPalette,
	now: number,
): string[] {
	const rows: string[] = [];
	const progress = session.progress;
	if (!progress) return rows;

	const dim = (text: string) => palette.paint("muted", text);
	const val = (text: string, role: PaletteRole = "output") => palette.paint(role, text);

	// Model
	if (progress.resolvedModel) {
		const model = sanitize(progress.resolvedModel);
		const fallback = progress.resolvedModelIsFallback ? " (fallback)" : "";
		rows.push(`${dim("model")} ${val(model + fallback)}`);
	}

	// Requests
	if (progress.requests > 0) {
		rows.push(`${dim("reqs")} ${val(String(progress.requests))}`);
	}

	// Tokens / context
	const parts: string[] = [];
	if (progress.tokens > 0) parts.push(`${progress.tokens}tok`);
	if (progress.contextTokens != null && progress.contextWindow != null) {
		parts.push(`${progress.contextTokens}/${progress.contextWindow}ctx`);
	} else if (progress.contextTokens != null) {
		parts.push(`${progress.contextTokens}ctx`);
	}
	if (parts.length > 0) {
		rows.push(`${dim("tok")} ${val(parts.join(" "))}`);
	}

	// Cost
	if (progress.cost > 0) {
		rows.push(`${dim("cost")} ${val(`$${progress.cost.toFixed(4)}`)}`);
	}

	// Retry/failure
	if (progress.retryState) {
		const rs = progress.retryState;
		rows.push(
			`${dim("retry")} ${val(`attempt ${rs.attempt}/${rs.maxAttempts}`, "warning")} ${truncate(sanitize(rs.errorMessage), contentWidth - 20)}`,
		);
	} else if (progress.retryFailure) {
		const rf = progress.retryFailure;
		rows.push(
			`${dim("retry")} ${val(`failed attempt ${rf.attempt}`, "error")} ${truncate(sanitize(rf.errorMessage), contentWidth - 25)}`,
		);
	}

	// Recent tools (last 3)
	const recent = progress.recentTools.slice(-3);
	for (const entry of recent) {
		const age = formatDuration(Math.max(0, now - entry.endMs));
		const name = truncate(sanitize(entry.tool), contentWidth - age.length - 3);
		rows.push(`  ${val(name)} ${dim(age)}`);
	}

	return rows;
}

// ── Panel title ───────────────────────────────────────────────────────────────

const PANEL_TITLE = "Subagents";

// ── Public render function ────────────────────────────────────────────────────

export interface AgentPanelRowsInput {
	sessions: readonly ExtensionAgentSession[];
	contentWidth: number;
	palette: SidebarPalette;
	now?: number;
	sessionExpansionOverrides?: ReadonlyMap<string, boolean>;
	sessionByRow?: Map<number, { id: string; expanded: boolean }>;
}

/**
 * Render the Subagents panel rows from an onAgentSessionsChange snapshot.
 * Returns an array of pre-painted, width-constrained strings.
 */
export function renderAgentPanelRows(input: AgentPanelRowsInput): string[] {
	const { sessions, contentWidth, palette, now = Date.now(), sessionExpansionOverrides = new Map(), sessionByRow } =
		input;
	const subagents = sessions.filter((session) => session.kind === "subagent");
	if (subagents.length === 0) return [palette.paint("dim", "No subagents")];

	// Main-agent detail is rendered by the existing activity panel.
	const active = subagents
		.filter((session) => session.status === "active")
		.sort((left, right) => right.lastUpdate - left.lastUpdate);
	const settled = subagents
		.filter((session) => session.status !== "active" && now - session.lastUpdate < SETTLED_SUBAGENT_TTL_MS)
		.sort((left, right) => right.lastUpdate - left.lastUpdate)
		.slice(0, BOUNDED_SETTLED_ROWS);
	const ordered = [...active, ...settled];
	if (ordered.length === 0) return [palette.paint("dim", "No subagents")];
	const rows: string[] = [];

	for (let i = 0; i < ordered.length; i++) {
		const session = ordered[i];
		if (i > 0) rows.push(""); // gap between agents
		const details = agentDetailRows(session, contentWidth, palette, now);
		const expandable = details.length > 0;
		const automaticallyExpanded = session.status === "active" || now - session.lastUpdate < 2_000;
		const expanded = expandable && (sessionExpansionOverrides.get(session.id) ?? automaticallyExpanded);
		if (expandable) sessionByRow?.set(rows.length, { id: session.id, expanded });
		rows.push(agentSummaryRow(session, contentWidth, palette, now, expandable ? expanded : undefined));
		if (expanded) rows.push(...details);
	}

	return rows;
}

export { PANEL_TITLE as AGENT_PANEL_TITLE };
