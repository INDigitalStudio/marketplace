import { homedir } from "node:os";
import { basename } from "node:path";
import type { ExtensionContext } from "./_compat.js";
import { type Component, type TUI, truncateToWidth, visibleWidth } from "./_compat.js";
import {
	type SidePaneCapableUI,
	type SidePaneComponentFactory,
	type ExtensionSidePaneOptions,
	type ExtensionAgentSession,
	getSidePaneUI,
} from "./side-pane-api.js";
import { renderAgentPanelRows, AGENT_PANEL_TITLE } from "./agent-rows.js";
import type { ThemeLike } from "./footer.js";
import { aggregateMetrics, formatTokens } from "./metrics.js";
import { createPalette, type PaletteRole, type SidebarPalette } from "./palette.js";
import {
	createSplitPaneController,
	type SplitPaneController,
	parseSgrMouseEvent,
	MIN_SIDEBAR_WIDTH,
	MIN_MAIN_WIDTH,
} from "./split-pane.js";
import {
	EMPTY_RUN_ACTIVITY,
	formatDuration,
	formatResponsePerformance,
	type RunActivitySnapshot,
	type ToolActivity,
} from "./run-activity.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	isSidebarPanelContributionId,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	type SidebarPanelData,
	type SidebarPanelRole,
	sanitizeSidebarPanelText,
} from "./sidebar-panels.js";
import {
	DEFAULT_CONFIG,
	type SidebarConfig,
	type SidebarState,
	type NormalizedTodo,
	type WorkspacePulseState,
} from "./types.js";
import type { WorkspacePulseData } from "./workspace-pulse.js";

export type {
	SidebarPanelContribution,
	SidebarPanelData,
	SidebarPanelDiscoveryEvent,
	SidebarPanelEvent,
	SidebarPanelEventTransport,
	SidebarPanelRegisterEvent,
	SidebarPanelRegistry,
	SidebarPanelRegistryOptions,
	SidebarPanelRole,
	SidebarPanelRow,
	SidebarPanelUnregisterEvent,
} from "./sidebar-panels.js";
export {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	DEFAULT_SIDEBAR_PANEL_LAYOUT,
	isSidebarPanelContributionId,
	isSidebarPanelId,
	isSidebarPanelRequestId,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
	registerSidebarPanel,
	SIDEBAR_PANEL_EVENT_CHANNEL,
	SIDEBAR_PANEL_MAX_ID_CHARS,
	SIDEBAR_PANEL_MAX_PANELS,
	SIDEBAR_PANEL_MAX_RAW_REQUEST_ID_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_ROW_CODE_UNITS,
	SIDEBAR_PANEL_MAX_RAW_TITLE_CODE_UNITS,
	SIDEBAR_PANEL_MAX_ROW_CHARS,
	SIDEBAR_PANEL_MAX_ROWS,
	SIDEBAR_PANEL_MAX_SOURCE_CHARS,
	SIDEBAR_PANEL_MAX_TITLE_CHARS,
	SIDEBAR_PANEL_MAX_TRACKED_SOURCES,
	sanitizeSidebarPanelText,
} from "./sidebar-panels.js";

export interface SidebarSnapshotInput {
	state: SidebarState;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames?: readonly string[];
	extensionStatuses: readonly string[];
	runActivity?: RunActivitySnapshot;
	todos?: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
	agentSessions?: readonly ExtensionAgentSession[];
}

export interface SidebarSnapshot extends SidebarState {
	projectName: string;
	cwd: string;
	sessionName?: string;
	sessionFile?: string;
	persisted: boolean;
	branchEntryCount: number;
	activeToolCount: number;
	availableToolCount: number;
	activeToolNames: readonly string[];
	runActivity: RunActivitySnapshot;
	todos: readonly NormalizedTodo[];
	sidebarPanels?: readonly SidebarPanelData[];
	agentSessions?: readonly ExtensionAgentSession[];
}

function workspacePulseData(pulse: WorkspacePulseState): WorkspacePulseData | undefined {
	return "data" in pulse ? pulse.data : undefined;
}

export function buildSidebarSnapshot(input: SidebarSnapshotInput): SidebarSnapshot {
	const pulseData = workspacePulseData(input.state.workspacePulse);
	const projectName = basename(pulseData?.root ?? input.cwd) || pulseData?.root || input.cwd;
	return {
		...input.state,
		projectName,
		cwd: input.cwd,
		...(input.sessionName ? { sessionName: input.sessionName } : {}),
		...(input.sessionFile ? { sessionFile: input.sessionFile } : {}),
		persisted: Boolean(input.sessionFile),
		branchEntryCount: input.branchEntryCount,
		activeToolCount: input.activeToolCount,
		availableToolCount: input.availableToolCount,
		activeToolNames: [...new Set((input.activeToolNames ?? []).map(sanitize).filter(Boolean))].sort((a, b) =>
			a.localeCompare(b, "en"),
		),
		extensionStatuses: input.extensionStatuses,
		runActivity: input.runActivity ?? EMPTY_RUN_ACTIVITY,
		todos: input.todos ?? [],
		sidebarPanels: input.sidebarPanels ?? [],
		agentSessions: input.agentSessions ?? [],
	};
}

const sanitize = (text: string): string =>
	text
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u001f\u007f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const display = (value: string | undefined): string => {
	const safe = value === undefined ? "" : sanitize(value);
	return safe || "—";
};

const finiteCount = (value: number): number => (Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);

function shortPath(path: string): string {
	const safe = sanitize(path);
	const home = homedir();
	if (safe === home) return "~";
	if (home && safe.startsWith(`${home}/`)) return `~${safe.slice(home.length)}`;
	return safe || "—";
}

function padToWidth(text: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const content = truncateToWidth(text, safeWidth, "");
	return `${content}${" ".repeat(Math.max(0, safeWidth - visibleWidth(content)))}`;
}

function renderDock(
	rows: string[],
	width: number,
	height: number,
	palette: SidebarPalette,
	resizing = false,
): string[] {
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const edge = resizing ? `${palette.paint("warning", "│")} ` : "  ";
	return Array.from({ length: safeHeight }, (_, index) => {
		const content = truncateToWidth(rows[index] ?? "", contentWidth, "");
		const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(content)));
		return truncateToWidth(`${edge}${content}${padding}`, safeWidth, "");
	});
}

function panelRows(
	title: string,
	rows: readonly string[],
	width: number,
	palette: SidebarPalette,
	theme: ThemeLike,
	role: PaletteRole,
	jewel: "✦" | "✧",
): string[] {
	const safeWidth = Math.max(4, Math.trunc(width));
	const innerWidth = Math.max(0, safeWidth - 4);
	const safeTitle = sanitizeSidebarPanelText(title, SIDEBAR_PANEL_MAX_TITLE_CHARS).toUpperCase();
	const crownPrefix = `╭─ ${jewel} `;
	const crownFill = "─".repeat(Math.max(0, safeWidth - visibleWidth(crownPrefix) - visibleWidth(safeTitle) - 2));
	const top = `${palette.paint(role, crownPrefix)}${theme.bold(
		palette.paint(role, safeTitle),
	)} ${palette.paint(role, `${crownFill}╮`)}`;
	const body = rows.map((row) => {
		const content = padToWidth(row, innerWidth);
		return `${palette.paint("dim", "│")} ${content} ${palette.paint("dim", "│")}`;
	});
	return [top, ...body, palette.paint("dim", `╰${"─".repeat(safeWidth - 2)}╯`), ""];
}

function valueRow(value: string | undefined, palette: SidebarPalette, role: PaletteRole): string {
	const text = display(value);
	return palette.paint(text === "—" ? "dim" : role, text);
}

const COMPACT_SIDEBAR_MAX_WIDTH = 39;

interface SidebarLayout {
	compact: boolean;
	showToolNames: boolean;
}

function sidebarLayout(width: number, config: SidebarConfig): SidebarLayout {
	const compact = width <= COMPACT_SIDEBAR_MAX_WIDTH;
	return {
		compact,
		showToolNames: config.showSidebarToolNames && !compact,
	};
}

function activityRole(activity: SidebarSnapshot["activity"]): PaletteRole {
	if (activity === "error") return "error";
	if (activity === "warning") return "warning";
	if (activity === "working") return "working";
	return "ready";
}

function activitySymbol(activity: SidebarSnapshot["activity"]): string {
	if (activity === "error") return "✕";
	if (activity === "warning") return "▲";
	if (activity === "working") return "◆";
	return "●";
}

function agentRows(
	snapshot: SidebarSnapshot,
	layout: SidebarLayout,
	contentWidth: number,
	palette: SidebarPalette,
	theme: ThemeLike,
): string[] {
	const activity = `${snapshot.activity.slice(0, 1).toUpperCase()}${snapshot.activity.slice(1)}`;
	const workingLabel =
		snapshot.activity === "working" && snapshot.workingLabel ? sanitize(snapshot.workingLabel).toLowerCase() : "";
	const activityText = workingLabel ? `${activity} · ${workingLabel}` : activity;
	const status = theme.bold(
		palette.paint(activityRole(snapshot.activity), `${activitySymbol(snapshot.activity)} ${activityText || "—"}`),
	);
	const model = valueRow(snapshot.modelId, palette, "primary");
	const provider = snapshot.provider ? palette.paint("muted", display(snapshot.provider).toUpperCase()) : "";
	const thinking = snapshot.thinkingLevel
		? palette.paint("primary", display(snapshot.thinkingLevel).toUpperCase())
		: "";
	const access =
		snapshot.modelId || snapshot.provider
			? palette.paint(
					snapshot.metrics.subscription ? "ready" : "muted",
					snapshot.metrics.subscription ? "SUBSCRIPTION" : "METERED",
				)
			: "";
	const separator = ` ${palette.paint("dim", "·")} `;

	if (layout.compact) {
		const rows = [status, model];
		if (provider) rows.push(provider);
		const secondary = [thinking, access].filter(Boolean);
		if (secondary.length > 0) rows.push(secondary.join(separator));
		return rows;
	}

	const metadata = [provider, thinking, access].filter(Boolean);
	return [
		spacedRow(status, model, contentWidth),
		metadata.length > 0 ? metadata.join(separator) : palette.paint("dim", "—"),
	];
}

function pulseIndicator(pulse: WorkspacePulseState): { symbol: string; role: PaletteRole } {
	if (pulse.status === "conflict") return { symbol: "✕", role: "error" };
	if (pulse.status === "changed") return { symbol: "▲", role: "warning" };
	if (pulse.status === "stale") return { symbol: "~", role: "warning" };
	if (pulse.status === "clean") return { symbol: "", role: "ready" };
	return { symbol: "", role: "dim" };
}

function formatPulseCount(value: number): string {
	const count = finiteCount(value);
	if (count < 1_000) return count.toString();
	if (count < 1_000_000) return `${(count / 1_000).toFixed(count < 10_000 ? 1 : 0)}k`;
	return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)}M`;
}

interface WorkspacePulseRows {
	core: string[];
	details: string[];
}

function workspacePulseRows(
	pulse: WorkspacePulseState,
	layout: SidebarLayout,
	palette: SidebarPalette,
): WorkspacePulseRows {
	if (pulse.status === "inspecting") return { core: [palette.paint("muted", "inspecting…")], details: [] };
	if (pulse.status === "not-repo") return { core: [palette.paint("dim", "not a Git repository")], details: [] };
	if (pulse.status === "unavailable") return { core: [palette.paint("warning", "Git unavailable")], details: [] };
	if (!("data" in pulse)) return { core: [], details: [] };

	const { snapshot } = pulse.data;
	if (pulse.status === "clean") return { core: [palette.paint("ready", "✓ clean")], details: [] };
	const tracked = `${formatPulseCount(snapshot.trackedFiles)} tracked`;
	const lines = `+${formatPulseCount(snapshot.linesAdded)}  −${formatPulseCount(snapshot.linesRemoved)}`;
	const role = pulse.status === "stale" ? "warning" : "primary";
	const prefix = pulse.status === "stale" ? "~ stale · " : "";
	const core = layout.compact
		? [palette.paint(role, `${prefix}${tracked}`), palette.paint(role, lines)]
		: [palette.paint(role, `${prefix}${tracked}  ${lines}`)];
	if (snapshot.conflicts > 0) core.push(palette.paint("error", `${finiteCount(snapshot.conflicts)} conflicts`));
	const details = [
		snapshot.untrackedFiles > 0
			? layout.compact
				? `?${formatPulseCount(snapshot.untrackedFiles)}`
				: `${formatPulseCount(snapshot.untrackedFiles)} untracked`
			: "",
		snapshot.binaryFiles > 0
			? layout.compact
				? `bin${formatPulseCount(snapshot.binaryFiles)}`
				: `${formatPulseCount(snapshot.binaryFiles)} binary`
			: "",
		snapshot.submodules > 0
			? layout.compact
				? `sub${formatPulseCount(snapshot.submodules)}`
				: `${formatPulseCount(snapshot.submodules)} submodule`
			: "",
	].filter(Boolean);
	return { core, details: details.length > 0 ? [palette.paint("muted", details.join(" · "))] : [] };
}

interface WorkspaceRows {
	identity: string[];
	location: string[];
	pulseCore: string[];
	pulseDetails: string[];
	session: string[];
}

function workspaceRows(snapshot: SidebarSnapshot, layout: SidebarLayout, palette: SidebarPalette): WorkspaceRows {
	const project = valueRow(snapshot.projectName, palette, "primary");
	const branch = snapshot.branch ? palette.paint("accent", display(snapshot.branch)) : "";
	const indicator = pulseIndicator(snapshot.workspacePulse);
	const gitState = branch && indicator.symbol ? palette.paint(indicator.role, indicator.symbol) : "";
	const identity = branch ? `${project} ${palette.paint("dim", "·")} ${branch} ${gitState}` : project;
	const identityRows = layout.compact ? [project, ...(branch ? [`${branch} ${gitState}`] : [])] : [identity];
	const pulseData = workspacePulseData(snapshot.workspacePulse);
	const location = pulseData?.relativeCwd
		? [palette.paint("muted", `./${sanitize(pulseData.relativeCwd)}`)]
		: pulseData
			? []
			: [palette.paint("muted", shortPath(snapshot.cwd))];
	const pulse = workspacePulseRows(snapshot.workspacePulse, layout, palette);
	const sessionName = snapshot.sessionName ? sanitize(snapshot.sessionName) : "";
	const session = [
		...(sessionName ? [palette.paint("primary", sessionName)] : []),
		`${palette.paint("primary", `${finiteCount(snapshot.branchEntryCount)} entries`)} ${palette.paint(
			"dim",
			"·",
		)} ${palette.paint(snapshot.persisted ? "ready" : "muted", snapshot.persisted ? "persisted" : "ephemeral")}`,
	];
	return {
		identity: identityRows,
		location,
		pulseCore: pulse.core,
		pulseDetails: pulse.details,
		session,
	};
}

function contextRole(snapshot: SidebarSnapshot, config: SidebarConfig): PaletteRole {
	const percent = snapshot.metrics.contextPercent;
	if (percent === null || !Number.isFinite(percent)) return "dim";
	if (percent >= config.contextDanger) return "error";
	if (percent >= config.contextWarning) return "warning";
	return "context";
}

function spacedRow(left: string, right: string, width: number): string {
	const safeWidth = Math.max(0, Math.trunc(width));
	const rightWidth = visibleWidth(right);
	const leftMax = Math.max(0, safeWidth - rightWidth - 1);
	const safeLeft = truncateToWidth(left, leftMax, "");
	const gap = " ".repeat(Math.max(1, safeWidth - visibleWidth(safeLeft) - rightWidth));
	return truncateToWidth(`${safeLeft}${gap}${right}`, safeWidth, "");
}

function contextRows(
	snapshot: SidebarSnapshot,
	config: SidebarConfig,
	contentWidth: number,
	layout: SidebarLayout,
	palette: SidebarPalette,
): string[] {
	const { metrics } = snapshot;
	const available =
		metrics.contextTokens !== null &&
		Number.isFinite(metrics.contextTokens) &&
		metrics.contextPercent !== null &&
		Number.isFinite(metrics.contextPercent);
	if (!available) {
		return [palette.paint("dim", "Context unavailable")];
	}

	const role = contextRole(snapshot, config);
	const usage = `${formatTokens(metrics.contextTokens ?? 0)} / ${
		metrics.contextWindow > 0 ? formatTokens(metrics.contextWindow) : "—"
	}`;
	const percent = `${metrics.contextPercent?.toFixed(1)}%`;
	const meterWidth = layout.compact
		? Math.max(1, Math.min(10, contentWidth - 2))
		: Math.max(1, Math.min(10, contentWidth - visibleWidth(usage) - visibleWidth(percent) - 4));
	const filled = Math.min(meterWidth, Math.max(0, Math.round(((metrics.contextPercent ?? 0) / 100) * meterWidth)));
	const meter = `${palette.paint("dim", "[")}${palette.paint(role, "■".repeat(filled))}${palette.paint(
		"dim",
		"·".repeat(Math.max(0, meterWidth - filled)),
	)}${palette.paint("dim", "]")}`;
	return [spacedRow(palette.paint(role, usage), palette.paint(role, percent), contentWidth), meter];
}

const currencyDecimals = (value: number): number =>
	Number.isFinite(value) ? Math.min(6, Math.max(0, Math.trunc(value))) : 0;

function formatUsageTokens(count: number): string {
	const safe = Number.isFinite(count) ? Math.max(0, count) : 0;
	if (safe < 1_000) return Math.trunc(safe).toString();
	if (safe < 1_000_000) return `${(safe / 1_000).toFixed(1)}k`;
	if (safe < 1_000_000_000) return `${(safe / 1_000_000).toFixed(1)}M`;
	return `${(safe / 1_000_000_000).toFixed(1)}B`;
}

function metricValue(label: string, value: string, palette: SidebarPalette, role: PaletteRole): string {
	return `${palette.paint("muted", label)} ${palette.paint(role, value)}`;
}

function metricPairRows(
	left: string,
	right: string,
	contentWidth: number,
	layout: SidebarLayout,
	palette: SidebarPalette,
): string[] {
	const separator = layout.compact ? ` ${palette.paint("dim", "·")} ` : "  ";
	const inline = `${left}${separator}${right}`;
	return visibleWidth(inline) <= contentWidth ? [inline] : [left, right];
}

function usageRows(
	snapshot: SidebarSnapshot,
	config: SidebarConfig,
	contentWidth: number,
	layout: SidebarLayout,
	palette: SidebarPalette,
): string[] {
	const { metrics } = snapshot;
	if (!metrics.usageAvailable && !metrics.costAvailable) return [];

	const rows: string[] = [];
	if (metrics.usageAvailable) {
		rows.push(
			...metricPairRows(
				metricValue("In", formatUsageTokens(metrics.input), palette, "input"),
				metricValue("Out", formatUsageTokens(metrics.output), palette, "output"),
				contentWidth,
				layout,
				palette,
			),
		);
		const hit =
			metrics.cacheHitPercent !== undefined && Number.isFinite(metrics.cacheHitPercent)
				? `${metrics.cacheHitPercent.toFixed(1)}%`
				: "—";
		rows.push(
			...metricPairRows(
				metricValue("Cache", formatUsageTokens(metrics.cacheRead), palette, "cache"),
				layout.compact
					? palette.paint(hit === "—" ? "dim" : "cache", hit)
					: metricValue("Hit", hit, palette, hit === "—" ? "dim" : "cache"),
				contentWidth,
				layout,
				palette,
			),
		);
	}
	if (metrics.costAvailable) {
		const cost = `$${Math.max(0, Number.isFinite(metrics.cost) ? metrics.cost : 0).toFixed(
			currencyDecimals(config.currencyDecimals),
		)}`;
		rows.push(metricValue("Cost", cost, palette, "cost"));
	}
	return rows;
}

function toolsStatusRows(
	snapshot: SidebarSnapshot,
	showToolNames: boolean,
	contentWidth: number,
	palette: SidebarPalette,
): string[] {
	const disclosure = showToolNames ? "▾" : "▸";
	return [
		spacedRow(
			palette.paint(
				"primary",
				`${finiteCount(snapshot.activeToolCount)} / ${finiteCount(snapshot.availableToolCount)} active`,
			),
			palette.paint("dim", disclosure),
			contentWidth,
		),
	];
}

function activeToolNameRows(snapshot: SidebarSnapshot, contentWidth: number, palette: SidebarPalette): string[] {
	const names = snapshot.activeToolNames.map((name) => palette.paint("primary", name));
	if (names.length === 0) return [];

	const leftColumnWidth = names.reduce(
		(maximum, name, index) => (index % 2 === 0 ? Math.max(maximum, visibleWidth(name)) : maximum),
		0,
	);
	const rightColumnWidth = names.reduce(
		(maximum, name, index) => (index % 2 === 1 ? Math.max(maximum, visibleWidth(name)) : maximum),
		0,
	);
	const columnGap = "  ";
	if (leftColumnWidth + visibleWidth(columnGap) + rightColumnWidth > contentWidth) return names;

	const rows: string[] = [];
	for (let index = 0; index < names.length; index += 2) {
		const left = names[index] ?? "";
		const right = names[index + 1];
		rows.push(right === undefined ? left : `${padToWidth(left, leftColumnWidth)}${columnGap}${right}`);
	}
	return rows;
}

function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [];
	const chunks: string[] = [];
	let remaining = text;
	while (visibleWidth(remaining) > width) {
		let cut = width;
		while (cut > 1 && visibleWidth(remaining.slice(0, cut)) > width) cut--;
		chunks.push(remaining.slice(0, cut));
		remaining = remaining.slice(cut);
	}
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

function todosRows(snapshot: SidebarSnapshot, contentWidth: number, palette: SidebarPalette): string[] {
	const todoList = snapshot.todos;
	if (todoList.length === 0) return [];

	const done = todoList.filter((t) => t.status === "completed").length;
	const total = todoList.length;
	const rows = [palette.paint("muted", `${done}/${total}`)];
	const visible =
		snapshot.runActivity.phase === "running"
			? todoList.filter((todo) => todo.status === "in_progress" || todo.status === "blocked")
			: todoList;

	for (const todo of visible) {
		let check: string;
		if (todo.status === "completed") check = palette.paint("ready", "✓");
		else if (todo.status === "in_progress") check = palette.paint("warning", "◐");
		else if (todo.status === "blocked") check = palette.paint("warning", "⚠");
		else if (todo.status === "abandoned") check = palette.paint("dim", "✕");
		else check = palette.paint("dim", "○");
		const id = palette.paint("accent", `#${todo.id}`);
		const textRaw = sanitize(todo.text);
		const text =
			todo.status === "completed" || todo.status === "abandoned"
				? palette.paint("dim", textRaw)
				: palette.paint("primary", textRaw);
		const prefix = `${check} ${id} `;
		const prefixWidth = visibleWidth(prefix);
		const textBudget = Math.max(1, contentWidth - prefixWidth);
		const wrapped = wrapText(textRaw, textBudget);
		if (wrapped.length === 0) {
			rows.push(prefix.trimEnd());
		} else {
			const painted =
				todo.status === "completed" || todo.status === "abandoned"
					? palette.paint("dim", wrapped[0]!)
					: palette.paint("primary", wrapped[0]!);
			rows.push(`${prefix}${painted}`);
			const indent = " ".repeat(prefixWidth);
			for (let i = 1; i < wrapped.length; i++) {
				const cont =
					todo.status === "completed" || todo.status === "abandoned"
						? palette.paint("dim", wrapped[i]!)
						: palette.paint("primary", wrapped[i]!);
				rows.push(`${indent}${cont}`);
			}
		}
	}
	return rows;
}

const exceptionStatusPattern = /\b(error|failed?|failure|warn(?:ing)?|offline|unavailable|blocked|degraded)\b/i;

function statusDetailPanelRole(snapshot: SidebarSnapshot): PaletteRole {
	return snapshot.extensionStatuses.some((status) =>
		/\b(error|failed?|failure|offline|unavailable)\b/i.test(sanitize(status)),
	)
		? "error"
		: "warning";
}

function statusDetailRows(snapshot: SidebarSnapshot, palette: SidebarPalette): string[] {
	const statuses = snapshot.extensionStatuses
		.map(sanitize)
		.filter((status) => status && exceptionStatusPattern.test(status));
	if (statuses.length === 0) return [];
	return [
		...statuses.map((status) => {
			const role: PaletteRole = /\b(error|failed?|failure|offline|unavailable)\b/i.test(status) ? "error" : "warning";
			return palette.paint(role, `${role === "error" ? "✕" : "▲"} ${status}`);
		}),
	];
}

interface ActivityGroups {
	core: string[];
	active: Array<{ id: string; row: string }>;
	recent: Array<{ id: string; row: string }>;
	aggregate: string[];
}

type SidebarRowAction = { type: "tools" } | { type: "subagent"; id: string; expanded: boolean };

interface SidebarGroup {
	name: string;
	panel?: string;
	panelId?: string;
	panelRole?: PaletteRole;
	panelJewel?: "✦" | "✧";
	rows: string[];
	required: boolean;
	dropRank: number;
	rowActions?: ReadonlyMap<number, SidebarRowAction>;
}

function renderGroups(
	groups: readonly SidebarGroup[],
	width: number,
	palette: SidebarPalette,
	theme: ThemeLike,
	actionByRow?: Map<number, SidebarRowAction>,
): string[] {
	const rendered: string[] = [];
	for (let index = 0; index < groups.length;) {
		const group = groups[index];
		if (!group) break;
		if (!group.panel) {
			rendered.push(...group.rows);
			index += 1;
			continue;
		}

		const rows: string[] = [];
		const rowActions = new Map<number, SidebarRowAction>();
		let next = index;
		while (groups[next]?.panel === group.panel && groups[next]?.panelId === group.panelId) {
			const nextGroup = groups[next];
			if (nextGroup) {
				for (const [row, action] of nextGroup.rowActions ?? []) rowActions.set(rows.length + row, action);
				rows.push(...nextGroup.rows);
			}
			next += 1;
		}
		if (rows.length > 0) {
			for (const [row, action] of rowActions) actionByRow?.set(rendered.length + row + 1, action);
			rendered.push(
				...panelRows(group.panel, rows, width, palette, theme, group.panelRole ?? "accent", group.panelJewel ?? "✦"),
			);
		}
		index = next;
	}
	return rendered;
}

function panelIdForTitle(title: string): string | undefined {
	return {
		AGENT: "agent",
		SUBAGENTS: "agents",
		ACTIVITY: "activity",
		ALERTS: "alerts",
		TODOS: "todos",
		CONTEXT: "context",
		WORKSPACE: "workspace",
		USAGE: "usage",
		TOOLS: "tools",
	}[title];
}

function contributedRows(panel: SidebarPanelData, palette: SidebarPalette): string[] {
	const rows = panel.rows.slice(0, SIDEBAR_PANEL_MAX_ROWS).map((row) => {
		const text = sanitizeSidebarPanelText(typeof row === "string" ? row : row.text, SIDEBAR_PANEL_MAX_ROW_CHARS);
		const role = typeof row === "string" ? panel.role : (row.role ?? panel.role);
		return palette.paint((role ?? "primary") as SidebarPanelRole, text);
	});
	return rows.filter((row) => visibleWidth(row) > 0);
}

function durationForTool(tool: ToolActivity, now: number): string {
	return formatDuration(tool.durationMs ?? Math.max(0, now - tool.startedAt));
}

function toolStatusRole(status: ToolActivity["status"]): PaletteRole {
	if (status === "failed") return "error";
	if (status === "running") return "working";
	return "ready";
}

function toolStatusLabel(tool: ToolActivity, now: number): string {
	const duration = durationForTool(tool, now);
	if (tool.status === "running") return duration;
	return `${tool.status} ${duration}`;
}

function toolActivityRow(
	tool: ToolActivity,
	contentWidth: number,
	palette: SidebarPalette,
	now: number,
	extraLive = 0,
): string {
	const safeName = sanitize(tool.name) || "tool";
	const safeSummary = sanitize(tool.summary);
	const status =
		extraLive > 0 && tool.status === "running"
			? `${durationForTool(tool, now)} · +${finiteCount(extraLive)}`
			: toolStatusLabel(tool, now);
	const statusWidth = visibleWidth(status);
	const nameWidth = Math.min(Math.max(visibleWidth(safeName), 4), 10, Math.max(0, contentWidth));
	const summaryWidth = Math.max(0, contentWidth - nameWidth - statusWidth - 2);
	const statusText = truncateToWidth(status, Math.max(0, contentWidth - nameWidth - summaryWidth - 2), "");
	const row = `${padToWidth(palette.paint("muted", safeName), nameWidth)} ${padToWidth(
		palette.paint(safeSummary ? "primary" : "dim", safeSummary || "—"),
		summaryWidth,
	)} ${palette.paint(toolStatusRole(tool.status), statusText)}`;
	return truncateToWidth(row, contentWidth, "");
}

function runSummaryRow(activity: RunActivitySnapshot, palette: SidebarPalette, now: number): string {
	if (activity.phase === "idle") return palette.paint("ready", "Ready");
	const duration =
		activity.phase === "settled"
			? formatDuration(activity.durationMs ?? Math.max(0, now - (activity.startedAt ?? now)))
			: formatDuration(Math.max(0, now - (activity.startedAt ?? now)));
	const role: PaletteRole = activity.phase === "running" ? "working" : activity.failedCount > 0 ? "error" : "ready";
	if (activity.phase === "settled") return palette.paint(role, `Last run · ${duration}`);

	const label = activity.turnNumber === undefined ? "Run" : `Turn ${finiteCount(activity.turnNumber)}`;
	return palette.paint(role, `${label} · ${activity.phase} ${duration}`);
}

function responsePerformanceRow(activity: RunActivitySnapshot, palette: SidebarPalette): string {
	return palette.paint("output", formatResponsePerformance(activity.performance));
}

function activityRows(
	activity: RunActivitySnapshot,
	contentWidth: number,
	palette: SidebarPalette,
	now: number,
): ActivityGroups {
	const liveTurn = activity.phase === "running";
	const activeIds = new Set(activity.activeTools.map((tool) => tool.id));
	const sortedActive = activity.activeTools
		.map((tool, index) => ({ index, tool }))
		.sort((left, right) => left.tool.startedAt - right.tool.startedAt || left.index - right.index)
		.map(({ tool }) => tool);
	const visibleActive = liveTurn ? sortedActive.slice(-1) : sortedActive;
	const extraLive = liveTurn ? Math.max(0, sortedActive.length - visibleActive.length) : 0;
	const active = visibleActive.map((tool) => ({
		id: tool.id,
		row: toolActivityRow(tool, contentWidth, palette, now, extraLive),
	}));
	const recent = liveTurn
		? []
		: activity.recentTools
				.filter((tool) => !activeIds.has(tool.id))
				.slice(0, 3)
				.map((tool) => ({ id: tool.id, row: toolActivityRow(tool, contentWidth, palette, now) }));
	const aggregateText = liveTurn ? "" : aggregateActivityText(activity);
	return {
		core: [runSummaryRow(activity, palette, now), responsePerformanceRow(activity, palette)],
		active,
		recent,
		aggregate: aggregateText ? [palette.paint(activity.failedCount > 0 ? "error" : "ready", aggregateText)] : [],
	};
}

function aggregateActivityText(activity: RunActivitySnapshot): string {
	const completed = finiteCount(activity.completedCount);
	const failed = finiteCount(activity.failedCount);
	if (completed === 0 && failed === 0) return "";
	return `tools ${completed} done · ${failed} failed`;
}

function activitySidebarGroups(
	snapshot: SidebarSnapshot,
	contentWidth: number,
	palette: SidebarPalette,
	now: number,
): SidebarGroup[] {
	const groups = activityRows(snapshot.runActivity, contentWidth, palette, now);
	const recentCount = groups.recent.length;
	const panelRole: PaletteRole =
		snapshot.runActivity.phase === "running" ? "working" : snapshot.runActivity.failedCount > 0 ? "error" : "ready";
	return [
		{
			name: "activityCore",
			panel: "ACTIVITY",
			panelRole,
			rows: groups.core,
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		...groups.active.map((active, index, rows) => ({
			name: `activityActive:${active.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [active.row],
			required: false,
			dropRank: 35 + (rows.length - index) / 100,
		})),
		...groups.recent.map((recent, index) => ({
			name: `activityRecent:${recent.id}`,
			panel: "ACTIVITY",
			panelRole,
			rows: [recent.row],
			required: false,
			dropRank: index === 0 ? 30 : 10 + (recentCount - index - 1),
		})),
		{
			name: "activityAggregate",
			panel: "ACTIVITY",
			panelRole,
			rows: groups.aggregate,
			required: false,
			dropRank: 20,
		},
	].filter((group) => group.rows.length > 0);
}

function composeGroups(
	groups: SidebarGroup[],
	height: number,
	width: number,
	palette: SidebarPalette,
	theme: ThemeLike,
): SidebarGroup[] {
	let candidate = groups.filter((group) => group.rows.length > 0);
	while (renderGroups(candidate, width, palette, theme).length > height) {
		let dropIndex = -1;
		let dropRank = Number.POSITIVE_INFINITY;
		for (const [index, group] of candidate.entries()) {
			if (group.required || group.dropRank >= dropRank) continue;
			dropRank = group.dropRank;
			dropIndex = index;
		}
		if (dropIndex === -1) return candidate;
		const dropName = candidate[dropIndex]?.name;
		candidate = candidate.filter((group, index) => (dropName ? group.name !== dropName : index !== dropIndex));
	}
	return candidate;
}

export function renderSidebarLines(
	snapshot: SidebarSnapshot,
	config: SidebarConfig,
	theme: ThemeLike,
	width: number,
	height: number,
	colorEnabled = true,
	now = Date.now(),
	resizing = false,
	sessionExpansionOverrides: ReadonlyMap<string, boolean> = new Map(),
	actionByRow?: Map<number, SidebarRowAction>,
): string[] {
	const palette = createPalette(theme, colorEnabled);
	const safeWidth = Math.max(0, Math.trunc(width));
	const safeHeight = Math.max(0, Math.trunc(height));
	if (safeWidth <= 0 || safeHeight <= 0) return [];
	const contentWidth = Math.max(0, safeWidth - 2);
	const panelContentWidth = Math.max(0, contentWidth - 4);
	const layout = sidebarLayout(safeWidth, config);
	const toolNameRows = layout.showToolNames ? activeToolNameRows(snapshot, panelContentWidth, palette) : [];
	const workspace = workspaceRows(snapshot, layout, palette);
	const subagentSessionByRow = new Map<number, { id: string; expanded: boolean }>();
	const subagentRows =
		config.sidebarPanelLayout.find((entry) => entry.id === "agents")?.visible !== false &&
		snapshot.agentSessions &&
		snapshot.agentSessions.length > 0
			? renderAgentPanelRows({
					sessions: snapshot.agentSessions,
					contentWidth: panelContentWidth,
					palette,
					sessionExpansionOverrides,
					sessionByRow: subagentSessionByRow,
				})
			: [];
	const groups: SidebarGroup[] = [
		...(resizing
			? [
					{
						name: "resize",
						rows: [palette.paint("warning", "RESIZE · drag divider"), ""],
						required: true,
						dropRank: Number.POSITIVE_INFINITY,
					},
				]
			: []),
		...(config.showSidebarAgent
			? [
					{
						name: "agent",
						panel: "AGENT",
						panelRole: activityRole(snapshot.activity),
						panelJewel:
							snapshot.activity === "working" && Math.floor(now / 400) % 2 === 1 ? ("✧" as const) : ("✦" as const),
						rows: agentRows(snapshot, layout, panelContentWidth, palette, theme),
						required: true,
						dropRank: Number.POSITIVE_INFINITY,
					},
				]
			: []),
		...activitySidebarGroups(snapshot, panelContentWidth, palette, now).map((group) => ({
			...group,
			required: group.name === "activityCore",
			dropRank: group.name === "activityCore" ? Number.POSITIVE_INFINITY : group.dropRank + 40,
		})),
		{
			name: "statusDetails",
			panel: "ALERTS",
			panelRole: statusDetailPanelRole(snapshot),
			rows: statusDetailRows(snapshot, palette),
			required: false,
			dropRank: 80,
		},
		{
			name: "todos",
			panel: "TODOS",
			panelRole: "accent",
			rows: config.showSidebarTodos ? todosRows(snapshot, panelContentWidth, palette) : [],
			required: false,
			dropRank: 90,
		},
		{
			name: "agents",
			panel: AGENT_PANEL_TITLE.toUpperCase(),
			panelId: "agents",
			panelRole: "working" as const,
			rows: subagentRows,
			rowActions: new Map(
				[...subagentSessionByRow].map(([row, session]) => [row, { type: "subagent", ...session }] as const),
			),
			required: false,
			dropRank: 85,
		},
		{
			name: "context",
			panel: "CONTEXT",
			panelRole: contextRole(snapshot, config),
			rows: contextRows(snapshot, config, panelContentWidth, layout, palette),
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.identity,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceLocation",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.location,
			required: false,
			dropRank: 5,
		},
		{
			name: "workspaceCore",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseCore,
			required: false,
			dropRank: 30,
		},
		{
			name: "workspaceDetails",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.pulseDetails,
			required: false,
			dropRank: 6,
		},
		{
			name: "workspaceSession",
			panel: "WORKSPACE",
			panelRole: "accent",
			rows: workspace.session,
			required: false,
			dropRank: 4,
		},
		{
			name: "usage",
			panel: "USAGE",
			panelRole: "output",
			rows: usageRows(snapshot, config, panelContentWidth, layout, palette),
			required: false,
			dropRank: 20,
		},
		{
			name: "toolsStatus",
			panel: "TOOLS",
			panelRole: "cache",
			rows: toolsStatusRows(snapshot, layout.showToolNames, panelContentWidth, palette),
			required: false,
			dropRank: 10,
			rowActions: new Map([[0, { type: "tools" }]]),
		},
		...toolNameRows.map((row, index, rows) => ({
			name: `activeToolNames:${index}`,
			panel: "TOOLS",
			panelRole: "cache" as const,
			rows: [row],
			required: false,
			dropRank: (rows.length - index) / 100,
		})),
	];

	// Keep panel content grouped while making the user-owned order the only
	// source of top-to-bottom composition. Contributed panels are available only
	// when a current registry snapshot exists; their saved entries remain in the
	// layout and are therefore still visible to Settings as unavailable.
	const contributed = new Map((snapshot.sidebarPanels ?? []).map((panel) => [panel.id, panel]));
	const grouped = new Map<string, SidebarGroup[]>();
	for (const group of groups) {
		const id = group.panel ? panelIdForTitle(group.panel) : undefined;
		if (!id) continue;
		group.panelId = id;
		const list = grouped.get(id) ?? [];
		list.push(group);
		grouped.set(id, list);
	}
	const ordered: SidebarGroup[] = groups.filter((group) => !group.panel);
	let availableVisible = false;
	for (const entry of config.sidebarPanelLayout) {
		if (!entry.visible) continue;
		const builtin = BUILTIN_SIDEBAR_PANEL_IDS.includes(entry.id as (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number]);
		const panel = isSidebarPanelContributionId(entry.id) ? contributed.get(entry.id) : undefined;
		if (builtin) {
			availableVisible = true;
			ordered.push(...(grouped.get(entry.id) ?? []));
		} else if (panel) {
			availableVisible = true;
			const rows = contributedRows(panel, palette);
			ordered.push({
				name: `contributed:${panel.id}`,
				panel: sanitize(panel.title).toUpperCase() || panel.id,
				panelId: panel.id,
				panelRole: panel.role ?? "accent",
				rows: rows.length > 0 ? rows : [palette.paint("dim", "No data")],
				required: false,
				dropRank: 25,
			});
		}
	}
	if (!availableVisible) {
		ordered.push({
			name: "empty",
			panel: "SIDEBAR",
			panelId: "__empty__",
			panelRole: "muted",
			rows: ["No available panels", "Open /sidebar-stats Settings"],
			required: true,
			dropRank: Number.POSITIVE_INFINITY,
		});
	}
	const composed = composeGroups(ordered, safeHeight, contentWidth, palette, theme);
	return renderDock(
		renderGroups(composed, contentWidth, palette, theme, actionByRow),
		safeWidth,
		safeHeight,
		palette,
		resizing,
	);
}

export interface SidebarComponentOptions {
	getSnapshot(): SidebarSnapshot;
	getConfig(): SidebarConfig;
	/** Returns terminal rows for height-aware rendering. Called from render(). */
	getHeight(): number;
	isResizing?(): boolean;
	theme: ThemeLike;
	colorEnabled?: boolean;
	onToggleTools?(): void;
}

function renderSidebarError(error: unknown, width: number, height: number, resizing = false): string[] {
	let detail = "Unknown error";
	try {
		detail = sanitize(error instanceof Error ? error.message : String(error)) || detail;
	} catch {
		// Keep the fallback render path safe even for unusual thrown values.
	}
	return renderDock(
		["Sidebar unavailable", detail],
		width,
		height,
		{
			paint: (_role, text) => text,
		},
		resizing,
	);
}

export type SidebarComponent = Component & {
	getLastRenderedLines: () => readonly string[];
	activateAtRow: (row: number) => boolean;
	dispose?(): void;
};

export function createSidebarComponent(options: SidebarComponentOptions): SidebarComponent {
	let lastRendered: string[] = [];
	let actionByRow = new Map<number, SidebarRowAction>();
	const sessionExpansionOverrides = new Map<string, boolean>();
	return {
		render(width) {
			const height = options.getHeight();
			let resizing = false;
			try {
				resizing = options.isResizing?.() ?? false;
				actionByRow = new Map();
				const lines = renderSidebarLines(
					options.getSnapshot(),
					options.getConfig(),
					options.theme,
					width,
					height,
					options.colorEnabled ?? true,
					Date.now(),
					resizing,
					sessionExpansionOverrides,
					actionByRow,
				);
				lastRendered = lines;
				return lines;
			} catch (error) {
				lastRendered = [];
				actionByRow.clear();
				return renderSidebarError(error, width, height, resizing);
			}
		},
		getLastRenderedLines: () => lastRendered,
		activateAtRow(row) {
			const action = actionByRow.get(row);
			if (!action) return false;
			if (action.type === "tools") options.onToggleTools?.();
			else sessionExpansionOverrides.set(action.id, !action.expanded);
			return true;
		},
		invalidate() {},
	};
}

export interface SidebarController {
	show(): void;
	hide(): void;
	toggle(): void;
	isVisible(): boolean;
	beginResize(): boolean;
	isResizing(): boolean;
	getWidth(): number;
	requestRender(): void;
	dispose(): void;
}

export interface SidebarControllerOptions {
	ctx: ExtensionContext;
	getSnapshot(): SidebarSnapshot;
	getConfig(): SidebarConfig;
	colorEnabled?: boolean;
	shouldAnimate?(): boolean;
	animationIntervalMs?: number;
	onWarning?(message: string): void;
	onError?(error: unknown): void;
	onToggleTools?(): void;
}

interface RetirableSidebarBinding {
	getSnapshot(): SidebarSnapshot;
	getConfig(): SidebarConfig;
	isResizing(): boolean;
	setResizing(reader: () => boolean): void;
	detach(): void;
}

function createDetachedSidebarSnapshot(cwd: string): SidebarSnapshot {
	return buildSidebarSnapshot({
		state: {
			activity: "ready",
			dirty: false,
			workspacePulse: { status: "unavailable" },
			metrics: aggregateMetrics([], { subscription: false, autoCompact: null }),
			extensionStatuses: [],
		},
		cwd,
		branchEntryCount: 0,
		activeToolCount: 0,
		availableToolCount: 0,
		activeToolNames: [],
		extensionStatuses: [],
		todos: [],
		sidebarPanels: [],
	});
}

function cloneSidebarSnapshot(snapshot: SidebarSnapshot): SidebarSnapshot {
	return structuredClone(snapshot);
}

function cloneSidebarConfig(config: SidebarConfig): SidebarConfig {
	return structuredClone(config);
}

function createRetirableSidebarBinding(options: SidebarControllerOptions): RetirableSidebarBinding {
	let readSnapshot: (() => SidebarSnapshot) | undefined = options.getSnapshot;
	let readConfig: (() => SidebarConfig) | undefined = options.getConfig;
	let readResizing: (() => boolean) | undefined;
	let snapshot = createDetachedSidebarSnapshot(typeof options.ctx.cwd === "string" ? options.ctx.cwd : "");
	let config = cloneSidebarConfig(DEFAULT_CONFIG);
	return {
		getSnapshot: () => (readSnapshot ? readSnapshot() : snapshot),
		getConfig: () => (readConfig ? readConfig() : config),
		isResizing: () => readResizing?.() ?? false,
		setResizing: (reader) => {
			if (readSnapshot) readResizing = reader;
		},
		detach: () => {
			if (readSnapshot) {
				try {
					snapshot = cloneSidebarSnapshot(readSnapshot());
				} catch {
					// The inert snapshot is already detached from the retired runtime.
				}
			}
			if (readConfig) {
				try {
					config = cloneSidebarConfig(readConfig());
				} catch {
					// Keep the last plain configuration snapshot.
				}
			}
			readSnapshot = undefined;
			readConfig = undefined;
			readResizing = undefined;
		},
	};
}

const SIDE_PANE_KEY = "sidebar-stats";

const ANSI_ESCAPE = /(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~])/g;

function handleClickInput(
	getComponent: () => SidebarComponent | undefined,
	getBounds: () => { columns: number; sidebarWidth: number } | undefined,
	isResizing: () => boolean,
): (data: string) => { consume?: boolean; data?: string } | undefined {
	return (data: string) => {
		if (isResizing()) return undefined;
		const mouse = parseSgrMouseEvent(data);
		if (!mouse || mouse.release || mouse.motion || (mouse.button & 3) !== 0) return undefined;
		const bounds = getBounds();
		if (!bounds) return undefined;
		const sidebarStart = bounds.columns - bounds.sidebarWidth + 1;
		if (mouse.x < sidebarStart) return undefined;
		const component = getComponent();
		const line = component?.getLastRenderedLines()[mouse.y - 1];
		if (!component || !line) return undefined;
		const clicked = Array.from(line.replace(ANSI_ESCAPE, ""))[mouse.x - sidebarStart];
		if (clicked !== "▾" && clicked !== "▸") return undefined;
		if (!component.activateAtRow(mouse.y - 1)) return undefined;
		component.invalidate?.();
		return { consume: true };
	};
}

export function createSidebarController(options: SidebarControllerOptions): SidebarController {
	const binding = createRetirableSidebarBinding(options);
	let enabled = false;
	let disposed = false;
	let generation = 0;
	let currentGeneration = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let sidebarComponent: SidebarComponent | undefined;
	let unsubscribeClickInput: (() => void) | undefined;
	const animationIntervalMs = Math.max(1, Math.trunc(options.animationIntervalMs ?? 1_000));

	// Resolve SidePaneCapableUI — fail closed if unavailable.
	const sidePaneUI = getSidePaneUI(options.ctx.ui);

	const reportError = (error: unknown) => {
		try {
			options.onError?.(error);
		} catch {
			// External error reporting must not interrupt lifecycle cleanup.
		}
	};

	const safely = (action: () => unknown): boolean => {
		try {
			action();
			return true;
		} catch (error) {
			reportError(error);
			return false;
		}
	};

	const stopAnimation = () => {
		if (!animationTimer) return;
		clearInterval(animationTimer);
		animationTimer = undefined;
	};

	const syncAnimation = () => {
		if (!enabled || options.shouldAnimate?.() !== true) {
			stopAnimation();
			return;
		}
		if (animationTimer) return;
		animationTimer = setInterval(() => sidebarComponent?.invalidate(), animationIntervalMs);
		animationTimer.unref?.();
	};

	/** Build a new SidebarComponent from the current snapshot/config. */
	const buildComponent = (getHeight: () => number, theme: unknown): SidebarComponent =>
		createSidebarComponent({
			getSnapshot: binding.getSnapshot,
			getConfig: binding.getConfig,
			getHeight,
			isResizing: binding.isResizing,
			theme: theme as ThemeLike,
			...(options.colorEnabled === undefined ? {} : { colorEnabled: options.colorEnabled }),
			...(options.onToggleTools ? { onToggleTools: options.onToggleTools } : {}),
		});

	/** Wire disclosure-arrow clicks on the stable component via terminal input. */
	const wireClickInput = (component: SidebarComponent) => {
		if (unsubscribeClickInput) {
			safely(unsubscribeClickInput);
			unsubscribeClickInput = undefined;
		}
		if (!split.subscribeInput) return;
		const handle = handleClickInput(
			() => sidebarComponent,
			() => {
				const columns = split.getTerminalColumns();
				if (columns === undefined) return undefined;
				return { columns, sidebarWidth: split.getSidebarWidth() };
			},
			binding.isResizing,
		);
		unsubscribeClickInput = split.subscribeInput(handle);
	};

	const paneFactory: SidePaneComponentFactory = (tui, theme) => {
		const typedTui = tui as TUI;
		safely(() => split.attach(typedTui));
		safely(() => split.enableMouseTracking());
		const component = buildComponent(() => typedTui.terminal.rows, theme);
		sidebarComponent = component;
		wireClickInput(component);
		if (enabled && generation === currentGeneration) syncAnimation();
		return component;
	};

	/**
	 * Publish the side pane: register the factory with setSidePane.
	 * OMP calls the factory once, retains the component, and re-renders via invalidate().
	 * Calling setSidePane with same key + new options updates options without disposal.
	 */
	const publishPane = () => {
		if (!sidePaneUI) return;
		if (!enabled || disposed) {
			safely(() => sidePaneUI.setSidePane(SIDE_PANE_KEY, undefined));
			return;
		}
		const hostOptions = split.hostOptions();
		const paneOptions: ExtensionSidePaneOptions = {
			width: hostOptions.width,
			...(hostOptions.minWidth !== MIN_SIDEBAR_WIDTH ? { minWidth: hostOptions.minWidth } : {}),
			...(hostOptions.minMainWidth !== MIN_MAIN_WIDTH ? { minMainWidth: hostOptions.minMainWidth } : {}),
		};
		safely(() => sidePaneUI.setSidePane(SIDE_PANE_KEY, paneFactory, paneOptions));
	};

	/** Update only the pane options (width) without replacing the component. */
	const updatePaneOptions = () => {
		if (!sidePaneUI || !enabled || disposed) return;
		const hostOptions = split.hostOptions();
		const paneOptions: ExtensionSidePaneOptions = {
			width: hostOptions.width,
			...(hostOptions.minWidth !== MIN_SIDEBAR_WIDTH ? { minWidth: hostOptions.minWidth } : {}),
			...(hostOptions.minMainWidth !== MIN_MAIN_WIDTH ? { minMainWidth: hostOptions.minMainWidth } : {}),
		};
		safely(() => sidePaneUI.setSidePane(SIDE_PANE_KEY, paneFactory, paneOptions));
	};

	const split: SplitPaneController = createSplitPaneController({
		subscribeInput: (handler) => options.ctx.ui.onTerminalInput(handler),
		onResizeChange: () => {
			// Resize state changed — update pane options so host can re-layout.
			safely(updatePaneOptions);
		},
		onOptionsChange: () => {
			// Width changed — update pane options (no component disposal).
			safely(updatePaneOptions);
		},
		...(options.onWarning ? { onWarning: options.onWarning } : {}),
		...(options.onError ? { onError: options.onError } : {}),
	});

	binding.setResizing(split.isResizing);

	const cleanupClickInput = () => {
		if (unsubscribeClickInput) {
			safely(unsubscribeClickInput);
			unsubscribeClickInput = undefined;
		}
	};

	const hide = () => {
		if (!enabled && !split.isEnabled()) return;
		enabled = false;
		currentGeneration = ++generation;
		stopAnimation();
		safely(split.cancelResize);
		safely(split.hide);
		safely(() => sidePaneUI?.setSidePane(SIDE_PANE_KEY, undefined));
		cleanupClickInput();
		sidebarComponent = undefined;
	};

	const show = () => {
		if (disposed || enabled) return;
		if (!sidePaneUI) {
			reportError(new Error("Sidebar Stats requires an OMP build newer than 18.1.7 with setSidePane"));
			return;
		}
		if (options.ctx.mode !== "tui") {
			reportError(new Error("Sidebar Stats sidebar requires TUI mode"));
			return;
		}

		enabled = true;
		currentGeneration = ++generation;
		if (!safely(split.show)) {
			enabled = false;
			stopAnimation();
			safely(split.hide);
			return;
		}
		safely(publishPane);
		syncAnimation();
	};

	return {
		show,
		hide,
		toggle() {
			if (enabled) hide();
			else show();
		},
		isVisible() {
			return enabled;
		},
		beginResize: split.beginResize,
		isResizing: split.isResizing,
		getWidth: split.getSidebarWidth,
		requestRender() {
			// Stable component: invalidate() triggers re-render without disposal.
			if (sidebarComponent) safely(() => sidebarComponent!.invalidate());
			syncAnimation();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			hide();
			binding.detach();
			safely(split.detach);
			safely(split.dispose);
		},
	};
}
