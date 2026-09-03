import { basename, join } from "node:path";
import {
	CONFIG_DIR_NAME,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	getAgentDir,
	SettingsManager,
} from "./_compat.js";
import type { KeyId } from "./_compat.js";
import {
	type CompletionNotification,
	type CompletionNotifier,
	createCompletionNotifier,
	type SpawnNotificationProcess,
} from "./completion-notifier.js";
import { loadConfig, type saveUserConfig, saveUserConfigPatch } from "./config.js";
// SidebarEditor and createFooterComponent disabled — footer/editor conflict with omp input row.
import {
	type DisplaySettingsRuntime,
	type OverlayLifetime,
	openSidebarControlCenter,
	openDisplaySettingsWorkspace,
} from "./menu.js";
import { createRunActivityTracker, type RunActivityTracker } from "./run-activity.js";
import type { SidebarPanelSetting } from "./settings-workspace.js";
import {
	buildSidebarSnapshot,
	createSidebarController,
	type SidebarController,
	type SidebarSnapshot,
} from "./sidebar.js";
import {
	BUILTIN_SIDEBAR_PANEL_IDS,
	createSidebarPanelRegistry,
	isSidebarPanelContributionId,
	type SidebarPanelRegistry,
} from "./sidebar-panels.js";
import { SidebarRuntime, createInertSidebarState } from "./state.js";
import type {
	SidebarConfig,
	SidebarState,
	FooterState,
	NormalizedTodo,
} from "./types.js";

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
	isSidebarPanelRole,
	isSidebarPanelSource,
	isSidebarPanelTextWithinRawLimit,
	normalizeSidebarPanelLayout,
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
	SIDEBAR_PANEL_PROTOCOL_VERSION,
} from "./sidebar-panels.js";
export type {
	BuiltinSidebarPanelId,
	ContributedSidebarPanelId,
	SidebarPanelId,
	SidebarPanelLayout,
	SidebarPanelLayoutEntry,
} from "./types.js";

export interface SidebarExtensionDependencies {
	/** @deprecated Retained for source compatibility; Sidebar no longer performs full config writes. */
	saveConfig?: typeof saveUserConfig;
	loadConfig?: typeof loadConfig;
	saveConfigPatch?: typeof saveUserConfigPatch;
	notificationPlatform?: NodeJS.Platform;
	spawnNotificationProcess?: SpawnNotificationProcess;
}

interface ActiveSession {
	readonly ctx: ExtensionContext;
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly token: LifecycleToken;
	readonly runtime: SidebarRuntime;
	readonly sidebar: SidebarController;
	readonly panelRegistry: SidebarPanelRegistry;
	readonly runActivity: RunActivityTracker;
	readonly completionNotifier: CompletionNotifier;
	readonly retiredState: SidebarState;
	readonly retiredConfig: SidebarConfig;
	readonly retiredCwd: string;
	readonly overlayCancellations: Set<() => void>;
	footerDisposer: (() => void) | undefined;
	footerGeneration: number;
	retired: boolean;
	unsubscribeAskUserBlocked: (() => void) | undefined;
	askUserBlocked: boolean;
	inputRequestSequence: number;
	todos: NormalizedTodo[];
	requestFooterRender: () => void;
	extensionStatuses: readonly string[];
}

interface LifecycleToken {
	readonly id: number;
}

export default function sidebarStatsExtension(
	pi: ExtensionAPI,
	dependencies: SidebarExtensionDependencies = {},
): void {
	const _loadConfig = dependencies.loadConfig ?? loadConfig;
	const saveConfigPatch = dependencies.saveConfigPatch ?? saveUserConfigPatch;
	const noopRender = (): void => undefined;
	let activeSession: ActiveSession | undefined;
	let enabled = true;
	let shortcutRegistered = false;
	let resizeShortcutRegistered = false;
	let lifecycleToken: LifecycleToken = { id: 0 };
	let initializingSessionManager: ExtensionContext["sessionManager"] | undefined;

	/** Retires the current lifecycle and records which initialization, if any, is now in flight. */
	function startLifecycleGeneration(
		sessionManagerClaim: ExtensionContext["sessionManager"] | undefined,
	): LifecycleToken {
		lifecycleToken = { id: lifecycleToken.id + 1 };
		initializingSessionManager = sessionManagerClaim;
		return lifecycleToken;
	}

	const requestAllRenders = (targetSession: ActiveSession): void => {
		if (activeSession !== targetSession) return;
		targetSession.requestFooterRender();
		targetSession.sidebar.requestRender();
	};
	const lifecycleGuardedSavePatch =
		(targetSession: ActiveSession): typeof saveUserConfigPatch =>
		async (path, patch) => {
			if (activeSession !== targetSession) throw new Error("Sidebar Stats is not active in this session");
			await saveConfigPatch(path, patch);
			if (activeSession !== targetSession) throw new Error("Sidebar Stats is not active in this session");
		};

	function createOverlayLifetime(token: LifecycleToken, cancellations: Set<() => void>): OverlayLifetime {
		return {
			isActive: () => activeSession?.token === token,
			register(cancel) {
				if (activeSession?.token !== token) {
					try {
						cancel();
					} catch {
						// Overlay cancellation is best-effort during lifecycle teardown.
					}
					return () => undefined;
				}
				cancellations.add(cancel);
				return () => cancellations.delete(cancel);
			},
		};
	}

	function updateExtensionStatuses(targetSession: ActiveSession, next: readonly string[]): void {
		if (activeSession !== targetSession) return;
		if (
			next.length === targetSession.extensionStatuses.length &&
			next.every((status, index) => status === targetSession.extensionStatuses[index])
		) {
			return;
		}
		targetSession.extensionStatuses = [...next];
		targetSession.sidebar.requestRender();
	}

	const VALID_TODO_STATUSES = new Set(["pending", "in_progress", "completed", "abandoned", "blocked"]);

	/** omp's todo tool result shape: { phases: [{ name, tasks: [{ content, status }] }] } */
	interface OmpTodoDetails {
		phases: Array<{ name: string; tasks: OmpTodoItem[] }>;
	}
	interface OmpTodoItem {
		content: string;
		status: string;
	}

	function isOmpTodoDetails(details: unknown): details is OmpTodoDetails {
		if (typeof details !== "object" || details === null) return false;
		if (!("phases" in details)) return false;
		const phases = (details as { phases: unknown }).phases;
		if (!Array.isArray(phases)) return false;
		return phases.every(
			(phase) =>
				typeof phase === "object" &&
				phase !== null &&
				Array.isArray((phase as { tasks: unknown }).tasks),
		);
	}

	/** Assign sequential IDs to flattened tasks — omp's TodoItem has no `id` field. */
	function flattenTodoPhases(details: OmpTodoDetails, startId = 1): NormalizedTodo[] {
		let id = startId;
		const result: NormalizedTodo[] = [];
		for (const phase of details.phases) {
			for (const task of phase.tasks) {
				if (!VALID_TODO_STATUSES.has(task.status)) continue;
				result.push({
					id: id++,
					text: task.content,
					status: task.status as NormalizedTodo["status"],
				});
			}
		}
		return result;
	}

	function reconstructTodos(ctx: ExtensionContext): NormalizedTodo[] {
		let result: NormalizedTodo[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo" || msg.isError) continue;
			const details = msg.details;
			if (isOmpTodoDetails(details)) {
				result = flattenTodoPhases(details);
			}
		}
		return result;
	}
	function getSidebarSnapshot(targetSession: ActiveSession): SidebarSnapshot {
		if (targetSession.retired || activeSession !== targetSession) {
			return buildSidebarSnapshot({
				state: targetSession.retiredState,
				cwd: targetSession.retiredCwd,
				branchEntryCount: 0,
				activeToolCount: 0,
				availableToolCount: 0,
				activeToolNames: [],
				extensionStatuses: [],
				todos: [],
				sidebarPanels: [],
			});
		}
		const { ctx, panelRegistry, runActivity, runtime } = targetSession;
		const sessionName = ctx.sessionManager.getSessionName();
		const sessionFile = ctx.sessionManager.getSessionFile();
		const activeTools = pi.getActiveTools();
		return buildSidebarSnapshot({
			state: runtime.getState(),
			cwd: ctx.cwd,
			...(sessionName ? { sessionName } : {}),
			...(sessionFile ? { sessionFile } : {}),
			branchEntryCount: ctx.sessionManager.getBranch().length,
			activeToolCount: activeTools.length,
			availableToolCount: pi.getAllTools().length,
			activeToolNames: activeTools,
			extensionStatuses: targetSession.extensionStatuses,
			runActivity: runActivity.getSnapshot(),
			todos: targetSession.todos,
			sidebarPanels: panelRegistry.getAvailable(),
		});
	}

	function contextUsesSessionManager(
		ctx: ExtensionContext | undefined,
		sessionManager: ExtensionContext["sessionManager"],
	): boolean {
		if (!ctx) return false;
		try {
			return ctx.sessionManager === sessionManager;
		} catch {
			return false;
		}
	}

	function getActiveSession(ctx: ExtensionContext | undefined): ActiveSession | undefined {
		const current = activeSession;
		return current && contextUsesSessionManager(ctx, current.sessionManager) ? current : undefined;
	}

	function clearFooter(session: ActiveSession, shouldClear: boolean): void {
		// Invalidate callbacks before touching Pi so a failed removal cannot leave a live footer.
		session.footerGeneration += 1;
		const footerDisposer = session.footerDisposer;
		session.footerDisposer = undefined;
		if (shouldClear) {
			try {
				session.ctx.ui.setFooter(undefined);
			} catch {
				// Pi may retain the old footer when removal fails; dispose it below regardless.
			}
			try {
				session.ctx.ui.setEditorComponent(undefined);
			} catch {
				// Composer restoration is best-effort and must not mask footer teardown.
			}
		}
		try {
			footerDisposer?.();
		} catch {
			// Footer disposal is best-effort and must not mask session teardown.
		}
	}

	/**
	 * Retirement is decided by session identity, so cleanup is best-effort: every owned
	 * resource gets a release attempt even if another disposer throws.
	 */
	function disposeSession(session: ActiveSession, options: { clearFooter?: boolean } = {}): void {
		session.retired = true;
		session.todos = [];
		session.extensionStatuses = [];
		session.askUserBlocked = false;
		session.inputRequestSequence = 0;
		session.requestFooterRender = noopRender;
		const cleanup = (action: () => void): void => {
			try {
				action();
			} catch {
				// Teardown must not leak later resources or replace the original failure.
			}
		};
		clearFooter(session, options.clearFooter === true);
		for (const cancel of Array.from(session.overlayCancellations)) cleanup(cancel);
		session.overlayCancellations.clear();
		cleanup(() => session.sidebar.dispose());
		cleanup(() => session.panelRegistry.dispose());
		cleanup(() => session.runtime.dispose());
		cleanup(() => session.runActivity.reset());
		cleanup(() => session.completionNotifier.reset());
		const unsubscribe = session.unsubscribeAskUserBlocked;
		session.unsubscribeAskUserBlocked = undefined;
		if (unsubscribe) cleanup(unsubscribe);
	}

	function teardownActiveSession(ctx?: ExtensionContext): void {
		const retiredSession = activeSession;
		activeSession = undefined;
		if (retiredSession) disposeSession(retiredSession, { clearFooter: true });
		else {
			try {
				ctx?.ui.setFooter(undefined);
			} catch {
				// No-active cleanup must not mask the original lifecycle failure.
			}
			try {
				ctx?.ui.setEditorComponent(undefined);
			} catch {
				// Composer restoration is best-effort during no-active cleanup.
			}
		}
	}

	async function setSidebarToolNames(
		ctx: ExtensionContext,
		visible: boolean | undefined,
		targetSession: ActiveSession,
	): Promise<void> {
		const { runtime: targetRuntime } = targetSession;
		const next = visible ?? !targetRuntime.getConfig().showSidebarToolNames;
		if (targetRuntime.getConfig().showSidebarToolNames !== next) {
			targetRuntime.setConfig({ ...targetRuntime.getConfig(), showSidebarToolNames: next });
		}
		try {
			await lifecycleGuardedSavePatch(targetSession)(join(getAgentDir(), "sidebar-stats.json"), {
				showSidebarToolNames: next,
			});
			if (activeSession !== targetSession) return;
			ctx.ui.notify(`Sidebar tool list ${next ? "expanded" : "collapsed"}`, "info");
		} catch (error) {
			if (activeSession !== targetSession) return;
			ctx.ui.notify(
				`Sidebar tool list changed for this session but could not be saved: ${
					error instanceof Error ? error.message : String(error)
				}`,
				"warning",
			);
		}
	}

	function completionNotification(
		ctx: ExtensionContext,
		kind: CompletionNotification["kind"],
		snapshot = activeSession?.runActivity.getSnapshot(),
	): CompletionNotification {
		const sessionName = ctx.sessionManager.getSessionName();
		return {
			kind,
			projectName: basename(ctx.cwd),
			...(sessionName ? { sessionName } : {}),
			...(snapshot === undefined ? {} : { completedToolCount: snapshot.completedCount }),
			...(snapshot === undefined ? {} : { failedToolCount: snapshot.failedCount }),
		};
	}

	function getSidebarPanelSettings(targetSession: ActiveSession): readonly SidebarPanelSetting[] {
		const configured = targetSession.runtime.getSidebarPanelLayout();
		const available = new Map(targetSession.panelRegistry.getAvailable().map((panel) => [panel.id, panel]));
		const configuredIds = new Set(configured.map((entry) => entry.id));
		return [
			...configured.map((entry) => {
				const contributed = isSidebarPanelContributionId(entry.id) ? available.get(entry.id) : undefined;
				return {
					id: entry.id,
					title: contributed?.title ?? entry.id,
					available:
						BUILTIN_SIDEBAR_PANEL_IDS.includes(entry.id as (typeof BUILTIN_SIDEBAR_PANEL_IDS)[number]) ||
						contributed !== undefined,
					visible: entry.visible,
				};
			}),
			...Array.from(available.values())
				.filter((panel) => !configuredIds.has(panel.id))
				.map((panel) => ({
					id: panel.id,
					title: panel.title,
					available: true,
					visible: false,
				})),
		];
	}

	async function openMenu(ctx: ExtensionContext): Promise<void> {
		const current = getActiveSession(ctx);
		if (!current) {
			ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
			return;
		}
		const { runtime: targetRuntime, sidebar: targetSidebar } = current;
		await openSidebarControlCenter(
			pi,
			ctx,
			targetRuntime,
			join(getAgentDir(), "sidebar-stats.json"),
			{
				isVisible: () => activeSession === current && targetSidebar.isVisible(),
				toggle: () => {
					if (activeSession === current) targetSidebar.toggle();
				},
				isToolListExpanded: () => activeSession === current && targetRuntime.getConfig().showSidebarToolNames,
				toggleToolList: async () => {
					if (activeSession === current) await setSidebarToolNames(ctx, undefined, current);
				},
				getSidebarPanelSettings: () => (activeSession === current ? getSidebarPanelSettings(current) : []),
			},
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
			{ lifetime: createOverlayLifetime(current.token, current.overlayCancellations) },
		);
	}

	async function openDisplay(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Sidebar Stats Display settings require TUI mode", "warning");
			return;
		}
		const current = getActiveSession(ctx);
		if (!current) {
			ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
			return;
		}
		const targetRuntime = current.runtime;
		const displayRuntime: DisplaySettingsRuntime = {
			getConfig: () => targetRuntime.getConfig(),
			getSidebarPanelSettings: () => getSidebarPanelSettings(current),
			getDisplaySettings: () => targetRuntime.getDisplaySettings(),
			getDisplayProvenance: () => targetRuntime.getDisplayProvenance(),
			getSessionDisplayOverride: () => targetRuntime.getSessionDisplayOverride(),
			replaceSessionDisplayOverride: (value) => {
				if (activeSession === current) targetRuntime.replaceSessionDisplayOverride(value);
			},
			clearSessionDisplayOverride: () => {
				if (activeSession === current) targetRuntime.clearSessionDisplayOverride();
			},
			applySavedUserDisplayPatch: (patch) => {
				if (activeSession === current) targetRuntime.applySavedUserDisplayPatch(patch);
			},
		};
		await openDisplaySettingsWorkspace(
			ctx,
			displayRuntime,
			join(getAgentDir(), "sidebar-stats.json"),
			() => requestAllRenders(current),
			lifecycleGuardedSavePatch(current),
			{ lifetime: createOverlayLifetime(current.token, current.overlayCancellations) },
		);
	}

	function installFooter(_targetSession: ActiveSession): void {
		// Footer and SidebarEditor chrome overlap omp's input row — disabled in omp.
	}

	const commandHandler = async (args: string, ctx: any): Promise<void> => {
		const parts = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
		const [action, ...extra] = parts;
		if (action === "tools") {
			const [toolAction, ...toolExtra] = extra;
			if (
				toolExtra.length > 0 ||
				(toolAction !== undefined && toolAction !== "on" && toolAction !== "off")
			) {
				ctx.ui.notify("Usage: /sidebar tools [on|off]", "warning");
				return;
			}
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			await setSidebarToolNames(ctx, toolAction === undefined ? undefined : toolAction === "on", current);
			return;
		}
		if (action === "on" || action === "off") {
			if (extra.length > 0) {
				ctx.ui.notify("Usage: /sidebar [on|off]", "warning");
				return;
			}
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			if (action === "on") current.sidebar.show();
			else current.sidebar.hide();
			return;
		}
		if (action === undefined || action === "toggle") {
			if (extra.length > 0) {
				ctx.ui.notify("Usage: /sidebar [on|off|toggle|tools|status|enable|disable]", "warning");
				return;
			}
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			current.sidebar.toggle();
			return;
		}
		if (action === "disable") {
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			enabled = false;
			current.sidebar.hide();
			updateExtensionStatuses(current, []);
			clearFooter(current, true);
			ctx.ui.notify("Sidebar Stats disabled", "info");
			return;
		}
		if (action === "enable") {
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			enabled = true;
			ctx.ui.notify("Sidebar Stats enabled", "info");
			return;
		}
		if (action === "status") {
			const current = getActiveSession(ctx);
			if (!current) {
				ctx.ui.notify("Sidebar Stats is not active in this session", "warning");
				return;
			}
			const state = current.runtime.getState();
			ctx.ui.notify(
				`Activity: ${state.activity} | Model: ${state.modelId ?? "—"} | Context: ${state.metrics.contextPercent ?? "—"}% | Cost: $${state.metrics.cost.toFixed(2)}`,
				"info",
			);
			return;
		}
		ctx.ui.notify(
			"Sidebar commands: /sidebar [on|off|toggle], tools [on|off], status, enable, disable", "info",
		);
	};


pi.registerCommand?.("sidebar", {
	description: "Open or control the Sidebar Stats status menu",
	handler: commandHandler,
});

	// Fallback: if registerCommand is unavailable, intercept input events directly
	if (typeof pi.on === "function") {
		pi.on("input", async (event, ctx) => {
			const text = (event as { text?: unknown } | undefined)?.text;
			if (typeof text !== "string") return undefined;
			const trimmed = text.trim();
			if (!trimmed.startsWith("/")) return undefined;
			const firstSpace = trimmed.indexOf(" ");
			const name = firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
			if (name !== "sidebar") return undefined;
			const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);
			const commandCtx = ctx;
			try {
				await commandHandler(args, commandCtx);
			} catch (err) {
				if (commandCtx.hasUI === false) throw err;
				const message = err instanceof Error ? err.message : String(err);
			commandCtx.ui.notify(`/sidebar failed: ${message}`, "error");
			}
		return { handled: true };
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		const initializationContext = ctx;
		if (initializationContext.mode !== "tui") {
			startLifecycleGeneration(undefined);
			if (activeSession) teardownActiveSession();
			return;
		}
		const initializationSessionManager = initializationContext.sessionManager;
		const initializationToken = startLifecycleGeneration(initializationSessionManager);

		let localRuntime: SidebarRuntime | undefined;
		let localSidebar: SidebarController | undefined;
		let localPanelRegistry: SidebarPanelRegistry | undefined;
		let localCompletionNotifier: CompletionNotifier | undefined;
		let candidateSession: ActiveSession | undefined;
		let publishedSession: ActiveSession | undefined;
		const isFresh = (): boolean => initializationToken === lifecycleToken;
		const requestCandidateRenders = (): void => {
			const current = activeSession;
			if (current?.token === initializationToken) requestAllRenders(current);
		};
		const localRunActivity = createRunActivityTracker({
			cwd: initializationContext.cwd,
			onChange: requestCandidateRenders,
		});
		try {
			const userPath = join(getAgentDir(), "sidebar-stats.json");
			const projectPath = join(initializationContext.cwd, CONFIG_DIR_NAME, "sidebar-stats.json");
			const loaded = await _loadConfig({
				userPath,
				projectPath,
				projectTrusted: initializationContext.isProjectTrusted(),
			});
			if (!isFresh()) return;
			for (const warning of loaded.warnings) initializationContext.ui.notify(warning, "warning");
			let autoCompact: boolean | null = null;
			try {
				autoCompact = SettingsManager.create(
					initializationContext.isProjectTrusted() ? initializationContext.cwd : getAgentDir(),
				).getCompactionSettings().enabled;
			} catch {
				initializationContext.ui.notify(
					"Could not read Pi compaction settings; compaction mode is unavailable",
					"warning",
				);
			}
			const candidateRuntime = new SidebarRuntime({
				pi,
				ctx: initializationContext,
				config: loaded.config,
				displayLayers: loaded.displayLayers,
				displayProvenance: loaded.displayProvenance,
				autoCompact,
				requestRender: requestCandidateRenders,
			});
			localRuntime = candidateRuntime;
			localPanelRegistry = createSidebarPanelRegistry({
				events: pi.events,
				instanceId: `sidebar-stats-${initializationToken.id}`,
				onChange: requestCandidateRenders,
			});
			const candidateCompletionNotifier = createCompletionNotifier({
				isEnabled: () =>
					enabled &&
					activeSession?.token === initializationToken &&
					candidateRuntime.getConfig().completionNotifications,
				...(dependencies.notificationPlatform === undefined
					? {}
					: { platform: dependencies.notificationPlatform }),
				...(dependencies.spawnNotificationProcess === undefined
					? {}
					: { spawn: dependencies.spawnNotificationProcess }),
			});
			localCompletionNotifier = candidateCompletionNotifier;
			localSidebar = createSidebarController({
				ctx: initializationContext,
				getSnapshot: () => {
					const current = activeSession;
					if (!current || current.token !== initializationToken)
						throw new Error("Sidebar Stats session is not published");
					return getSidebarSnapshot(current);
				},
				getConfig: () =>
					activeSession?.token === initializationToken ? candidateRuntime.getConfig() : loaded.config,
				colorEnabled: !("NO_COLOR" in process.env),
				shouldAnimate: () => activeSession?.token === initializationToken && localRunActivity.isRunning(),
				onWarning: (message) => initializationContext.ui.notify(message, "warning"),
				onError: (error) =>
					initializationContext.ui.notify(
						`Sidebar Stats sidebar failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					),
			});
			if (!isFresh()) {
				localSidebar.dispose();
				localPanelRegistry?.dispose();
				localRunActivity.reset();
				candidateCompletionNotifier.reset();
				candidateRuntime.dispose();
				return;
			}

			const nextSession: ActiveSession = {
				ctx: initializationContext,
				sessionManager: initializationContext.sessionManager,
				token: initializationToken,
				runtime: candidateRuntime,
				sidebar: localSidebar,
				panelRegistry: localPanelRegistry,
				runActivity: localRunActivity,
				completionNotifier: candidateCompletionNotifier,
				retiredState: createInertSidebarState(autoCompact),
				retiredConfig: structuredClone(loaded.config),
				retiredCwd: initializationContext.cwd,
				overlayCancellations: new Set(),
				footerDisposer: undefined,
				footerGeneration: 0,
				retired: false,
				unsubscribeAskUserBlocked: undefined,
				askUserBlocked: false,
				inputRequestSequence: 0,
				todos: reconstructTodos(initializationContext),
				requestFooterRender: noopRender,
				extensionStatuses: [],
			};
			candidateSession = nextSession;
			const askUserToken = nextSession.token;
			nextSession.unsubscribeAskUserBlocked = pi.events.on("rpiv:ask-user:blocked", (data) => {
				const current = activeSession;
				if (!current || current.token !== askUserToken) return;
				if (typeof data !== "object" || data === null || !("active" in data)) return;
				const active = (data as { active?: unknown }).active;
				if (active === false) {
					current.askUserBlocked = false;
					return;
				}
				if (active !== true || current.askUserBlocked) return;
				current.askUserBlocked = true;
				current.inputRequestSequence += 1;
				current.completionNotifier.inputRequested(
					`blocked-${current.inputRequestSequence}`,
					completionNotification(current.ctx, "input-requested", current.runActivity.getSnapshot()),
				);
			});
			if (!isFresh()) {
				disposeSession(nextSession);
				return;
			}
			const previousSession = activeSession;
			activeSession = nextSession;
			publishedSession = nextSession;
			if (previousSession) disposeSession(previousSession, { clearFooter: true });

			// Shortcuts, footer, and sidebar auto-show disabled in omp — they capture keyboard input.
		} catch (error) {
			const cleanup = (action: () => void): void => {
				try {
					action();
				} catch {
					// Preserve the initialization failure and keep attempting candidate cleanup.
				}
			};
			if (!publishedSession) {
				if (candidateSession) disposeSession(candidateSession);
				else {
					const sidebar = localSidebar;
					const panelRegistry = localPanelRegistry;
					const completionNotifier = localCompletionNotifier;
					const runtime = localRuntime;
					if (sidebar) cleanup(() => sidebar.dispose());
					if (panelRegistry) cleanup(() => panelRegistry.dispose());
					cleanup(() => localRunActivity.reset());
					if (completionNotifier) cleanup(() => completionNotifier.reset());
					if (runtime) cleanup(() => runtime.dispose());
				}
				if (!isFresh()) return;
				initializationContext.ui.notify(
					`Sidebar Stats could not start: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
				return;
			}
			if (!isFresh()) return;
			if (activeSession !== publishedSession) return;
			teardownActiveSession(initializationContext);
			initializationContext.ui.notify(
				`Sidebar Stats could not start: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		} finally {
			if (lifecycleToken === initializationToken) initializingSessionManager = undefined;
		}
	});

	pi.on("session_tree", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.todos = reconstructTodos(ctx);
		requestAllRenders(current);
	});

	pi.on("agent_start", (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startRun();
		current.completionNotifier.runStarted();
		current.runtime.setActivity("working");
	});
	pi.on("turn_start", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.startTurn(event.turnIndex);
		current.completionNotifier.runStarted();
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	pi.on("before_provider_request", (_event, ctx) => {
		getActiveSession(ctx)?.runActivity.startResponse();
	});
	pi.on("message_update", (event, ctx) => {
		const estimatedOutputTokens = estimateTokens(event.message);
		if (estimatedOutputTokens <= 0) return;
		getActiveSession(ctx)?.runActivity.updateResponseEstimate(estimatedOutputTokens);
	});
	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return;
		getActiveSession(ctx)?.runActivity.finishResponse(event.message.usage.output);
	});
	pi.on("tool_execution_start", (event, ctx) => {
		getActiveSession(ctx)?.runActivity.startTool(event);
	});
	pi.on("tool_execution_end", (event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runActivity.finishTool(event);
		current.runtime.scheduleWorkspacePulseRefresh();
	});
	// Collapse todo tool output when sidebar shows todos
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "todo") return;
		const current = getActiveSession(ctx);
		if (!current || event.isError) return;

		const details = event.details;
		if (!isOmpTodoDetails(details)) return;
		const todoList = flattenTodoPhases(details);
		// Keep state updates independent from whether the TODO panel is currently presented.
		current.todos = todoList;
		const sidebarVisible = current.sidebar.isVisible();
		if (sidebarVisible) current.sidebar.requestRender();
		const sidebarTodoLayout = current.runtime
			.getConfig()
			.sidebarPanelLayout.find((entry) => entry.id === "todos");
		if (
			!current.runtime.getConfig().showSidebarTodos ||
			sidebarTodoLayout?.visible === false ||
			!sidebarVisible ||
			todoList.length === 0
		)
			return;
		const done = todoList.filter((t) => t.status === "completed").length;
		return {
			content: [{ type: "text", text: `${done}/${todoList.length} done · see sidebar` }],
		};
	});
// Cast pi.on to accept event names from pi-atelier that may fire at runtime
// even though they're not in omp's TS type definitions.
const onEvent = pi.on.bind(pi) as unknown as (
	event: string,
	handler: (event: any, ctx: ExtensionContext) => void,
) => void;

onEvent("agent_settled", (_event, ctx) => {
	const current = getActiveSession(ctx);
	if (!current || !ctx.isIdle()) return;
	current.runActivity.settle();
	current.runtime.setActivity("ready");
	current.sidebar.requestRender();
	current.completionNotifier.turnSettled(
		completionNotification(current.ctx, "turn-settled", current.runActivity.getSnapshot()),
	);
});
	pi.on("turn_end", async (_event, ctx) => {
		const current = getActiveSession(ctx);
		if (!current) return;
		current.runtime.refreshUsage();
		await current.runtime.flushWorkspacePulseRefresh();
	});
onEvent("model_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
onEvent("thinking_level_select", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
pi.on("session_compact", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
onEvent("session_info_changed", (_event, ctx) => getActiveSession(ctx)?.runtime.refreshUsage());
	pi.on("session_shutdown", (_event, ctx) => {
		const current = getActiveSession(ctx);
		const initializing = initializingSessionManager;
		const cancelsInitialization = initializing !== undefined && contextUsesSessionManager(ctx, initializing);
		if (initializing && !cancelsInitialization) {
			// An unrelated session is shutting down; retire it but leave the newer initializer authoritative.
			if (current) teardownActiveSession();
			return;
		}
		if (!current && activeSession !== undefined && !cancelsInitialization) return;
		startLifecycleGeneration(undefined);
		if (current) teardownActiveSession();
	});
}
