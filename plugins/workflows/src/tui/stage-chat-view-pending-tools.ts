import type { AgentSessionEvent } from "../_compat.js";
import type { StageChatViewContext } from "./stage-chat-view-types.js";

export function replayPendingToolExecutions(ctx: StageChatViewContext): void {
	const events = ctx.handle?.isDisposed === true ? [] : (ctx.handle?.pendingToolExecutionEvents?.() ?? []);
	for (const event of events) ctx.chatHost.applyAgentEvent(event as AgentSessionEvent);
}
