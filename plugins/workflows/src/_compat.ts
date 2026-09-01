/**
 * Compatibility layer for ported Atomic workflow engine.
 *
 * Re-exports symbols from @oh-my-pi/pi-coding-agent that Atomic's source
 * originally imported from @bastani/atomic (its own internal package).
 * Ports/stubs the rest with simplified implementations.
 *
 * Import specifiers rewritten: `from "./_compat.js"` → `from "./_compat.js"`
 */

// ── Re-exports from @oh-my-pi/pi-coding-agent (omp SDK) ──────────────────────

export {
  createAgentSession,
  AgentSession,
  SessionManager,
  getAgentDir,
  keyHint,
  rawKeyHint,
} from "@oh-my-pi/pi-coding-agent";

export type { AgentSession as _AgentSessionType } from "@oh-my-pi/pi-coding-agent";

// ── Stubs for symbols not exported by @oh-my-pi/pi-coding-agent ───────────────

export function keyText(_keybinding: string): string {
  return "";
}

export type CreateAgentSessionOptions = Record<string, unknown>;

// ── Constants ────────────────────────────────────────────────────────────────

export const CONFIG_DIR_NAME = ".pi";
export const CONFIG_DIR_NAMES = [".pi"];
export const WORKFLOW_STAGE_SUBAGENT_GUARD_ENV = "PI_WORKFLOW_STAGE_SUBAGENT_GUARD";
export const TRANSCRIPT_JUMP_TO_END_URL = "atomic-ui://transcript/jump-to-end";

// ── Utility functions ─────────────────────────────────────────────────────────

export function getAgentDirs(): string[] {
  return [getAgentDir()];
}

export function getProjectConfigPaths(cwd: string, ...segments: string[]): string[] {
  return [".pi"].map((name) => {
    const path = [cwd, name, ...segments];
    // Simple join
    return path.join("/");
  });
}

export function getEnvValue(name: string): string | undefined {
  return process.env[name];
}

export function isStaleExtensionContextError(error: unknown): error is Error {
  return error instanceof Error && error.message.includes("extension ctx is stale");
}

export function createChildProcessEnvironment(
  overrides?: Record<string, string | undefined>,
  baseEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...(baseEnv ?? process.env), ...overrides, AI_AGENT: "pi" };
}

const GIT_LOCAL_ENV_VARS = [
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_COMMITTER_DATE",
  "GIT_SEQUENCE_EDITOR", "GIT_EDITOR", "GIT_PAGER",
] as const;

export function createGitEnvironment(
  overrides?: Record<string, string | undefined>,
  baseEnv?: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  const base = baseEnv ?? process.env;
  for (const key of Object.keys(base)) {
    if (!GIT_LOCAL_ENV_VARS.includes(key as (typeof GIT_LOCAL_ENV_VARS)[number])) {
      env[key] = base[key];
    }
  }
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      env[key] = overrides[key];
    }
  }
  return env;
}

// ── Callback wrappers (simplified — no reporter in omp) ─────────────────────

export async function runCallback<T>(
  descriptor: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  return callback();
}

export function runSynchronousCallback<T>(
  descriptor: string,
  callback: () => T,
): T {
  return callback();
}

// ── Codex fast mode (no codex in omp) ────────────────────────────────────────

export function isCodexFastModeCandidateModelId(_modelId: string): boolean {
  return false;
}

export function shouldApplyCodexFastModeForScope(
  _modelId: string,
  _scope: unknown,
  _mode: unknown,
): boolean {
  return false;
}

// ── Structured output ────────────────────────────────────────────────────────

export interface StructuredOutputCapture<TValue = unknown> {
  value: TValue | undefined;
  called: boolean;
}

export function createStructuredOutputCapture<TValue = unknown>(): StructuredOutputCapture<TValue> {
  return { value: undefined, called: false };
}

// Minimal ToolDefinition type
export type ToolDefinition = any;

export function defineTool(_options: any): ToolDefinition {
  // Minimal — omp's registerTool handles real tool definitions
  return _options;
}

export function createStructuredOutputTool(options: {
  schema: unknown;
  capture: StructuredOutputCapture;
}): ToolDefinition {
  return defineTool({
    name: "structured_output",
    label: "Structured Output",
    description: "Output structured data conforming to a JSON schema.",
    parameters: options.schema,
    async execute(_params: any) {
      return { content: [{ type: "text" as const, text: "" }] };
    },
  });
}

export type PromptOptions = any;

export function createAskUserQuestionToolDefinition(_options?: {
  deferredToWorkflow?: boolean;
}): ToolDefinition {
  return defineTool({
    name: "ask_user_question",
    label: "Ask User Question",
    description: "Ask the user a question and wait for their response.",
    parameters: { type: "object" as const, properties: {}, required: [] },
    async execute() {
      return {
        content: [{ type: "text" as const, text: "UI not available in this context." }],
        terminate: false,
      };
    },
  });
}

// ── Session-scoped extension state ──────────────────────────────────────────

const extensionStateMap = new WeakMap<object, Map<string, unknown>>();

export function sessionScopedExtensionState<T>(
  scope: object,
  key: string,
  create: () => T,
): T {
  let m = extensionStateMap.get(scope);
  if (!m) {
    m = new Map();
    extensionStateMap.set(scope, m);
  }
  let value = m.get(key) as T | undefined;
  if (value === undefined) {
    value = create();
    m.set(key, value);
  }
  return value;
}

// ── Message conversion ───────────────────────────────────────────────────────

export function convertToLlm(messages: any[]): any[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// ── TUI stubs ─────────────────────────────────────────────────────────────────

export class TranscriptFollowIndicator {
  constructor(_opts?: any) {}
  invalidate(): void {}
  render(_width: number): any[] {
    return [];
  }
}

export class ChatSessionHost {
  constructor(_opts?: any) {}
  invalidate(): void {}
  render(_width: number): any[] {
    return [];
  }
}

export type ChatSessionHostStyle = any;

// ── Reactive widgets ──────────────────────────────────────────────────────────

export type ReactiveWidgetAction = "mount" | "unmount" | "update" | "none";
export type ReactiveWidgetFactory = any;
export type ReactiveWidgetRenderState = any;
export type ReactiveWidgetTimerApi = any;
export type ReactiveWidgetTimerHandle = any;
export type ReactiveWidgetComponent = any;

export function decideReactiveWidgetAction(
  prev: string[] | undefined,
  nextLines: string[],
): ReactiveWidgetAction {
  if (!prev || prev.length === 0) return "mount" as ReactiveWidgetAction;
  if (nextLines.length === 0) return "unmount" as ReactiveWidgetAction;
  const same = prev.length === nextLines.length && prev.every((l, i) => l === nextLines[i]);
  return same ? ("none" as ReactiveWidgetAction) : ("update" as ReactiveWidgetAction);
}

export function installReactiveWidget(_options: any): { dispose(): void } {
  return { dispose() {} };
}

// ── Model fallback / retry ───────────────────────────────────────────────────

export type ModelFallbackFailureKind = string;
export type ModelFallbackFailureSignal = any;
export type ModelFallbackFailureSource = string;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const modelFailureMessage = errorMessage;

export function isRetryableModelFailure(_error: unknown): boolean {
  return false;
}

export function isRetryableSameModelFailure(_error: unknown): boolean {
  return false;
}

export function normalizeModelFailureSignal(error: unknown): {
  kind: string;
  message: string;
  source: string;
} {
  return {
    kind: "unknown",
    message: errorMessage(error),
    source: "string_fallback",
  };
}

export type RetryDecision = any;
export type RetryPolicySettings = any;

export function nextRetryDecision(
  _settings: RetryPolicySettings,
  _retriesSpent: number,
  _eligible: boolean,
): RetryDecision {
  return { shouldRetry: false, delayMs: 0 };
}

// ── Additional type-only exports (use `any`) ────────────────────────────────

export type AgentSessionEvent = any;
export type ChatMessageEntry = any;
export type ChatMessageRenderOptions = any;
export type DefaultResourceLoaderInheritanceSnapshot = any;
export type KeybindingsManager = any;
export type ReadonlyFooterDataProvider = any;
export type SessionInfo = any;
export type SettingsManager = any;
export type Theme = any;
export type ModelCycleResult = any;
export type ToolDefinitionTypeAlias = any;
export type VerbatimCompactionResult = any;
export type SubagentChildPolicy = any;
export type PackageSource = any;

// ── getSupportedThinkingLevels (from @bastani/pi-ai/compat) ───────────────────

export function getSupportedThinkingLevels(_modelId: string): string[] {
  return ["off"];
}
