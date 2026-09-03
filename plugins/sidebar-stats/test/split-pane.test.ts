import { describe, expect, it } from "bun:test";
import type { TUI } from "../src/_compat.js";
import { createSplitPaneController } from "../src/split-pane.js";

describe("split pane resizing", () => {
	it("passes ordinary input through and resizes by dragging the divider", () => {
		let input: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
		let unsubscribed = false;
		const controller = createSplitPaneController({
			subscribeInput(handler) {
				input = handler;
				return () => {
					unsubscribed = true;
				};
			},
		});
		controller.attach({ terminal: { columns: 120, write() {} } } as unknown as TUI);
		controller.show();

		expect(input?.("x")).toBeUndefined();
		expect(input?.("\x1b[<0;100;10M")).toBeUndefined();
		expect(input?.("\x1b[<0;68;10M")?.consume).toBe(true);
		expect(controller.isResizing()).toBe(true);
		expect(input?.("\x1b[<32;75;10M")?.consume).toBe(true);
		expect(controller.getSidebarWidth()).toBe(45);
		expect(input?.("\x1b[<0;75;10m")?.consume).toBe(true);
		expect(controller.isResizing()).toBe(false);

		controller.hide();
		expect(unsubscribed).toBe(true);
	});
});
