import { describe, expect, it } from "bun:test";
import { AGENT_PANEL_TITLE } from "../src/agent-rows.js";
import { buildSidebarSnapshot, createSidebarComponent } from "../src/sidebar.js";
import { createInertSidebarState } from "../src/state.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function snapshot(status: "active" | "completed" = "active", lastUpdate = Date.now()) {
	return buildSidebarSnapshot({
		state: createInertSidebarState(),
		cwd: "/project",
		branchEntryCount: 0,
		activeToolCount: 1,
		availableToolCount: 3,
		activeToolNames: ["read"],
		extensionStatuses: [],
		agentSessions: [
			{
				id: "worker-1",
				kind: "subagent",
				label: "Worker",
				status,
				lastUpdate,
				progress: {
					index: 0,
					id: "worker-1",
					agent: "task",
					agentSource: "builtin",
					status: "running",
					task: "work",
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 1,
					tokens: 12,
					cost: 0,
					durationMs: 1000,
					resolvedModel: "test-model",
				},
			},
		],
	});
}

describe("sidebar disclosures", () => {
	it("labels the agent-session panel as Subagents", () => {
		expect(AGENT_PANEL_TITLE).toBe("Subagents");
	});

	it("routes the Tools disclosure to the configured toggle", () => {
		let toggles = 0;
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 100,
			theme,
			colorEnabled: false,
			onToggleTools: () => toggles++,
		});
		const lines = [...component.render(42)];
		const toolsRow = lines.findIndex((line) => line.includes("1 / 3 active"));
		expect(lines[toolsRow]).toContain("▸");
		expect(component.activateAtRow(toolsRow)).toBe(true);
		expect(toggles).toBe(1);
		expect(lines.find((line) => line.includes("AGENT"))).not.toContain("▾ AGENT");
	});

	it("collapses and expands each subagent independently", () => {
		const component = createSidebarComponent({
			getSnapshot: snapshot,
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 100,
			theme,
			colorEnabled: false,
		});
		const expanded = [...component.render(42)];
		const subagentRow = expanded.findIndex((line) => line.includes("sub:Worker"));
		expect(expanded[subagentRow]).toContain("▾");
		expect(expanded.some((line) => line.includes("test-model"))).toBe(true);
		expect(component.activateAtRow(subagentRow)).toBe(true);
		const collapsed = [...component.render(42)];
		expect(collapsed.find((line) => line.includes("sub:Worker"))).toContain("▸");
		expect(collapsed.some((line) => line.includes("test-model"))).toBe(false);
		expect(component.activateAtRow(collapsed.findIndex((line) => line.includes("sub:Worker")))).toBe(true);
		expect(component.render(42).some((line) => line.includes("test-model"))).toBe(true);
	});

	it("starts older settled subagents collapsed, then honors the manual override", () => {
		const component = createSidebarComponent({
			getSnapshot: () => snapshot("completed", Date.now() - 5_000),
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 100,
			theme,
			colorEnabled: false,
		});
		const initial = [...component.render(42)];
		const subagentRow = initial.findIndex((line) => line.includes("sub:Worker"));
		expect(initial[subagentRow]).toContain("▸");
		expect(initial.some((line) => line.includes("test-model"))).toBe(false);

		expect(component.activateAtRow(subagentRow)).toBe(true);
		const expanded = [...component.render(42)];
		expect(expanded.find((line) => line.includes("sub:Worker"))).toContain("▾");
		expect(expanded.some((line) => line.includes("test-model"))).toBe(true);
	});

	it("hides completed or failed subagents once idle for 1 minute", () => {
		const now = Date.now();
		const component = createSidebarComponent({
			getSnapshot: () => snapshot("completed", now - 61_000),
			getConfig: () => DEFAULT_CONFIG,
			getHeight: () => 100,
			theme,
			colorEnabled: false,
		});
		const lines = [...component.render(42)];
		expect(lines.some((line) => line.includes("sub:Worker"))).toBe(false);
		expect(lines.some((line) => line.includes("No subagents"))).toBe(true);
	});
});
