# Atomic Bridge

Detects the Atomic workflow engine and bridges it to omp sessions via system prompt injection.

## When to Use

- A project has an `.atomic/` directory with workflow definitions
- User wants to use Atomic's durable, checkpointed workflow graphs from omp
- User wants to author, run, or monitor Atomic workflows from within an omp session

## What It Does

### session_start
1. Checks if `.atomic/` directory exists in the project root
2. Checks if the `atomic` binary is installed
3. Checks if `.atomic/workflows/` directory exists
4. Logs detection status:
   - All present: `[atomic-bridge] Atomic detected. Workflows available in .atomic/workflows/. Run: atomic workflow list`
   - Binary + `.atomic/` but no workflows dir: hints to author workflows
   - `.atomic/` exists but no binary: hints to install Atomic

### before_agent_start
If Atomic was detected on session start, injects a system prompt section that teaches the agent:
- Available `atomic workflow` CLI commands (list, run, status, connect, reload)
- When to use workflows vs inline work (decision rubric)
- The 8 built-in workflow patterns (fan-out-and-synthesize, adversarial-verification, etc.)
- How to author workflows (natural language description or hand-write TypeScript)
- Key concepts: stages, durable tools, human gates, Intercom, composition, schemas, checkpoint/resume

## Requirements

The extension is inert unless:
1. `atomic` binary is on `$PATH`
2. `.atomic/` directory exists in the project root

Without both, it does nothing — no errors, no interference.

## Authoring Workflows

Workflows are TypeScript files in `.atomic/workflows/*.ts`:

```typescript
import { workflow } from "@bastani/atomic/workflows";
import { Type } from "typebox";

export default workflow({
  name: "explain-file",
  description: "Explain a file with tracked workflow stages.",
  inputs: {
    path: Type.String({ description: "File path to explain." }),
  },
  outputs: {
    explanation: Type.String({ description: "Explanation of the file's purpose, risks, and key symbols." }),
  },
  run: async (ctx) => {
    const explanation = await ctx.task("explain", {
      prompt: `Read ${String(ctx.inputs.path)} and explain purpose, risks, and key symbols.`,
      context: "fresh",
    });
    return { explanation: explanation.text };
  },
});
```

After authoring or editing, run `atomic workflow reload` to rediscover workflow resources.

## Running Workflows

```bash
# List all discovered workflows
atomic workflow list

# Inspect required inputs before launch
atomic workflow inputs explain-file

# Launch a named workflow run (background)
atomic workflow explain-file path="src/index.ts"

# List all runs
atomic workflow status

# Inspect a specific run
atomic workflow status <run-id>

# Attach to a running workflow for steering
atomic workflow connect <run-id>
```

## Built-in Workflow Patterns

| Pattern | What it does |
|---|---|
| `fan-out-and-synthesize` | Partition work → parallel branches → synthesis barrier |
| `adversarial-verification` | Worker → fresh verifier fan-out → gate → bounded repair |
| `generate-and-filter` | Generate candidates → filter by rubric → shortlist |
| `tournament` | Whole-task attempts → seeded ring scoring → full ranking |
| `loop-until-done` | Durable ledger → iteration/evaluator loop → success or bound exhaustion |
| `classify-and-act` | Classify request → route to category-specific work |
| `goal` | Autonomous implementation with reviewer-gated completion |
| `ralph` | Research-first autonomous implementation with bounded review |

## Workflow Context Primitives

- `ctx.task(name, { prompt, context, schema, reads, output, outputMode })` — tracked model stage
- `ctx.chain([...stages])` — sequential stages with handoffs
- `ctx.parallel([...stages], { concurrency })` — parallel branches
- `ctx.tool(name, args, fn)` — durable cached side effect (doesn't re-run on resume)
- `ctx.workflow(childDef, { inputs,.stageName })` — compose nested workflow
- `ctx.ui.input(prompt)` / `confirm(prompt)` / `select(prompt, options)` / `editor(prompt)` — human gates
- `ctx.exit({ status, reason, outputs })` — early terminal exit

## Key Concepts

- **Stages**: Named, tracked model execution units. Each gets its own session context.
- **Durable tools**: Side effects wrapped in `ctx.tool()` are checkpointed. On resume, the cached result is returned without re-executing `fn`.
- **Human gates**: `ctx.ui.*` primitives pause the workflow for human decisions at any point in the graph.
- **Intercom**: Messages between stages. Queued delivery to pending stages. Used for steering live stages.
- **Composition**: Parent workflows call children via `ctx.workflow(childDef)`. Children are flattened into the parent graph.
- **Schemas**: TypeBox schemas enforce typed I/O between stages. Inputs and outputs are validated at runtime.
- **Checkpoint/resume**: Workflows checkpoint to `.atomic/workflows/runs/`. Can be interrupted, resumed across sessions, and inspected.

## Activation

This extension activates when the project has an `.atomic/` directory. It is a global extension installed to `~/.omp/agent/extensions/` (via the project-loader plugin) or as a standalone global plugin.

## Inert Behavior

If `.atomic/` does not exist or `atomic` binary is not installed, the extension silently does nothing. No errors, no interference with normal omp operation.
