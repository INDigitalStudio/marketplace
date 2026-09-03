/**
 * Split-pane width and mouse-resize controller.
 *
 * With the setSidePane API, OMP manages the layout split — this module only
 * owns sidebar width state, mouse/keyboard resize interaction, and the
 * options object passed to setSidePane. All overlay/fullscreen adapter code
 * is removed; the host handles rendering.
 */

import type { TUI } from "./_compat.js";
import { matchesKey } from "./_compat.js";

export const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
export const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(SGR_MOUSE);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export const DEFAULT_SIDEBAR_WIDTH = 52;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
	onWarning?(message: string): void;
	/** Called when width options change and setSidePane should be re-invoked. */
	onOptionsChange?(options: SplitPaneHostOptions): void;
}

/** The options shape passed to ctx.ui.setSidePane. */
export interface SplitPaneHostOptions {
	width: number;
	minWidth: number;
	minMainWidth: number;
}

export interface SplitPaneController {
	/** Attach to a TUI instance for terminal dimensions and mouse I/O. */
	attach(tui: TUI): void;
	/** Detach from TUI; disables mouse tracking. */
	detach(): void;
	show(): void;
	hide(): void;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	isEnabled(): boolean;
	beginResize(): boolean;
	finishResize(): void;
	cancelResize(): void;
	isResizing(): boolean;
	hostOptions(): SplitPaneHostOptions;
	/** Current terminal columns from attached TUI. */
	getTerminalColumns(): number | undefined;
	enableMouseTracking(): void;
	disableMouseTracking(): void;
	subscribeInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): (() => void) | undefined;
	dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	const minimumSidebar = Math.max(1, finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH));
	const maximumSidebar = Math.max(
		minimumSidebar,
		finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
	);
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
	let sidebarWidth = clamp(
		finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
		minimumSidebar,
		maximumSidebar,
	);
	let tui: TUI | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let controller: SplitPaneController;

	const safely = (action: () => unknown) => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Cleanup and error reporting are best effort; continue with remaining actions.
		}
	};

	const visibleAt = (terminalWidth: number): boolean =>
		enabled && Number.isFinite(terminalWidth) && terminalWidth >= minimumMain + minimumSidebar + 1;

	const computeHostOptions = (): SplitPaneHostOptions => ({
		width: sidebarWidth,
		minWidth: minimumSidebar,
		minMainWidth: minimumMain,
	});

	const notifyOptionsChange = () => {
		safely(() => options.onOptionsChange?.(computeHostOptions()));
	};

	const stopResize = (restore: boolean) => {
		if (!resizing) return;
		if (restore) sidebarWidth = resizeStartWidth;
		dragging = false;
		resizing = false;
		safely(() => options.onResizeChange?.(false));
		notifyOptionsChange();
	};

	const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (!dragging) return undefined;
				stopResize(false);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
				const columns = tui?.terminal.columns ?? 0;
				if (columns > 0) {
					const dividerX = columns - sidebarWidth;
					if (Math.abs(mouse.x - dividerX) <= 1) {
						if (!resizing) {
							resizeStartWidth = sidebarWidth;
							resizing = true;
							safely(() => options.onResizeChange?.(true));
						}
						dragging = true;
						return { consume: true };
					}
				}
				return undefined;
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain - 1);
				sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
				notifyOptionsChange();
				return { consume: true };
			}
			return dragging ? { consume: true } : undefined;
		}
		if (!resizing) return undefined;
		if (matchesKey(data, "shift+left")) {
			controller.setSidebarWidth(sidebarWidth + 4);
			return { consume: true };
		}
		if (matchesKey(data, "shift+right")) {
			controller.setSidebarWidth(sidebarWidth - 4);
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			controller.setSidebarWidth(sidebarWidth + 1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			controller.setSidebarWidth(sidebarWidth - 1);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			stopResize(false);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			stopResize(true);
			return { consume: true };
		}
		return undefined;
	};

	controller = {
		attach(nextTui: TUI) {
			if (disposed) throw new Error("Cannot attach a disposed split pane");
			if (tui === nextTui) return;
			if (tui) throw new Error("Split pane is already attached to another TUI");
			tui = nextTui;
		},
		detach() {
			if (unsubscribeInput) safely(unsubscribeInput);
			unsubscribeInput = undefined;
			if (tui) safely(() => tui!.terminal.write(DISABLE_MOUSE));
			tui = undefined;
		},
		show() {
			if (disposed || enabled) return;
			enabled = true;
			if (options.subscribeInput && !unsubscribeInput) unsubscribeInput = options.subscribeInput(handleResizeInput);
			notifyOptionsChange();
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			if (unsubscribeInput) safely(unsubscribeInput);
			unsubscribeInput = undefined;
			if (tui) safely(() => tui!.terminal.write(DISABLE_MOUSE));
		},
		setSidebarWidth(width) {
			const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
			if (next === sidebarWidth) return;
			sidebarWidth = next;
			notifyOptionsChange();
		},
		getSidebarWidth: () => sidebarWidth,
		beginResize() {
			if (resizing) return true;
			if (!enabled) {
				options.onWarning?.("Sidebar is not ready to resize");
				return false;
			}
			if (!options.subscribeInput) {
				options.onWarning?.("Terminal input is unavailable for sidebar resizing");
				return false;
			}
			resizeStartWidth = sidebarWidth;
			dragging = false;
			resizing = true;
			try {
				options.onResizeChange?.(true);
				return true;
			} catch (error) {
				stopResize(true);
				safely(() => options.onError?.(error));
				return false;
			}
		},
		finishResize: () => stopResize(false),
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		hostOptions: computeHostOptions,
		getTerminalColumns: () => tui?.terminal.columns,
		enableMouseTracking() {
			if (tui) safely(() => tui!.terminal.write(ENABLE_MOUSE));
		},
		disableMouseTracking() {
			if (tui) safely(() => tui!.terminal.write(DISABLE_MOUSE));
		},
		subscribeInput: options.subscribeInput ? (handler) => options.subscribeInput!(handler) : undefined,
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			if (unsubscribeInput) safely(unsubscribeInput);
			unsubscribeInput = undefined;
			if (tui) safely(() => tui!.terminal.write(DISABLE_MOUSE));
			tui = undefined;
		},
	};
	return controller;
}
