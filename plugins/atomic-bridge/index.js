import { execFileSync } from "child_process";
import { existsSync, statSync } from "fs";
import { join } from "path";

let detected = false;

function hasAtomicBinary() {
  try {
    execFileSync("which", ["atomic"], { stdio: "pipe", timeout: 3000 });
    return true;
  } catch (_) {
    return false;
  }
}

function hasAtomicDir(cwd) {
  const dir = join(cwd, ".atomic");
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

function hasWorkflows(cwd) {
  const dir = join(cwd, ".atomic", "workflows");
  try {
    return existsSync(dir) && statSync(dir).isDirectory();
  } catch (_) {
    return false;
  }
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd || process.cwd();
    const atomicDir = hasAtomicDir(cwd);
    if (!atomicDir) return;

    const binary = hasAtomicBinary();
    const workflows = hasWorkflows(cwd);

    if (binary && workflows) {
      detected = true;
      console.log(
        `[atomic-bridge] Atomic detected. ${workflows ? "Workflows available in .atomic/workflows/" : "No .atomic/workflows/ directory."} Run: atomic workflow list`
      );
    } else if (binary && !workflows) {
      console.log(
        `[atomic-bridge] Atomic binary found and .atomic/ exists, but no workflows/ directory. Author workflows in .atomic/workflows/*.ts`
      );
    } else {
      console.log(
        `[atomic-bridge] .atomic/ directory found but 'atomic' binary is not installed. Install Atomic to enable durable workflow execution.`
      );
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!detected) return;

    const prompt = [
      "## Atomic Workflow Engine",
      "",
      "Atomic's verifiable workflow engine is active in this session.",
      "Workflows are TypeScript files in `.atomic/workflows/*.ts` using `workflow({...})` from `@bastani/atomic/workflows`.",
      "",
      "### Available Commands",
      "- `atomic workflow list` — list discovered workflows",
      "- `atomic workflow inputs <name>` — inspect required inputs before launch",
      "- `atomic workflow <name> key=value` — launch a named workflow run (background)",
      "- `atomic workflow status` — list all runs",
      "- `atomic workflow status <run-id>` — inspect a specific run",
      "- `atomic workflow connect <run-id>` — attach to a running workflow for steering",
      "- `atomic workflow reload` — rediscover workflow resources after editing",
      "",
      "### When to Use a Workflow",
      "Use a workflow for non-trivial work with a verifiable objective: implementation, debugging, migrations, reviews with repair loops, release processes, or any task with multiple stages, dependencies, parallel branches, validation gates, or explicit loop/stop conditions.",
      "Use direct inline work only for tiny, deterministic, low-risk edits.",
      "",
      "### Built-in Workflow Patterns",
      "- `fan-out-and-synthesize` — partition work, run parallel branches, synthesize results",
      "- `adversarial-verification` — worker → fresh verifier fan-out → gate → bounded repair",
      "- `generate-and-filter` — generate candidates, filter by rubric, shortlist",
      "- `tournament` — whole-task attempts, seeded ring scoring, full ranking",
      "- `loop-until-done` — durable ledger, iteration/evaluator loop, success or bound exhaustion",
      "- `classify-and-act` — classify request, route to category-specific work",
      "- `goal` — autonomous implementation with reviewer-gated completion",
      "- `ralph` — research-first autonomous implementation with bounded review",
      "",
      "### Authoring",
      "Describe a workflow in natural language and the agent can write the TypeScript definition.",
      "Or hand-write `.atomic/workflows/<name>.ts` using `workflow({...})` and run `atomic workflow reload`.",
      "",
      "### Key Concepts",
      "- **Stages** are tracked, named steps: `ctx.task()`, `ctx.chain()`, `ctx.parallel()`",
      "- **Durable tools** (`ctx.tool()`) checkpoint side effects — they don't re-run on resume",
      "- **Human gates** (`ctx.ui.input`, `confirm`, `select`, `editor`) pause for decisions",
      "- **Intercom** delivers messages between stages, even to stages that haven't started yet",
      "- **Composition** (`ctx.workflow(child)`) nests reusable workflow definitions",
      "- **Schemas** (TypeBox) enforce typed I/O between stages",
      "- **Checkpoint/resume** — workflows can be interrupted, resumed, and inspected across sessions",
    ].join("\n");

    return { systemPrompt: prompt };
  });
}
