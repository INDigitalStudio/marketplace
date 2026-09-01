import * as path from "path";
import * as fs from "fs";

const RULES_FILE = "rules/path-access-control.md";

const TEMPLATE = `---
type: infrastructure
---

# Path Access Control Rule

**Purpose**
Define which paths agents may access by default, and which require explicit user permission.

**Allowed Paths (read/write)**

- \`./\` – project root (all project files)
- \`~/.omp/\` – global OMP configuration and extensions
- \`~/.agents/\` – global agent harness skills and rules
- \`rules/\` – agent path/policy rules (this file)
- \`xd://\` – all internal OMP tool device paths (security_scan, ast_grep, ast_edit, debug, github, lsp, inspect_image, browser, checkpoint, rewind, memory_edit, retain, reflect, recall, unfold, generate_image, tts, mcp__*)
- \`skill://\` – skill instructions and files
- \`agent://\` – agent output artifacts
- \`history://\` – agent transcripts
- \`artifact://\` – artifact content
- \`security://\` – security scans and findings
- \`local://\` – plan artifacts and shared subagent content
- \`vault://\` – Obsidian vault read/edit
- \`mcp://\` – MCP resources
- \`issue://\` – GitHub issues
- \`pr://\` – pull requests
- \`omp://\` – harness documentation
- \`memory://\` – long-term memory
- \`ssh://\` – remote file access

**Read-Only Paths**

- (none—add paths here that agents may read but not modify)

**Blocked Paths**

- Any path that resolves outside the repo root requires explicit user permission before access
- Any path not listed above requires explicit user permission before access

**Enforcement**

- Agents **MUST** check this rule before accessing paths not listed under **Allowed** or **Read-Only**.
- If a path is blocked, the agent must either abort the operation or request explicit user permission.
- User-granted permission for a specific task carries across the session — no need to re-confirm for each file within the approved scope.
`;

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const rulesDir = path.join(ctx.cwd, "rules");
    const rulesPath = path.join(ctx.cwd, RULES_FILE);
    if (!fs.existsSync(rulesPath)) {
      try {
        fs.mkdirSync(rulesDir, { recursive: true });
        fs.writeFileSync(rulesPath, TEMPLATE, "utf-8");
        console.log(`[path-guard] Created ${RULES_FILE} with template. Edit it to restrict access for this project.`);
      } catch (e) {
        console.warn(`[path-guard] Could not create ${RULES_FILE}: ${e.message}`);
      }
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!["write", "edit"].includes(event.toolName)) return;

    const rulesPath = path.join(ctx.cwd, RULES_FILE);
    if (!fs.existsSync(rulesPath)) return;

    let content;
    try {
      content = fs.readFileSync(rulesPath, "utf-8");
    } catch {
      return;
    }

    const { allowed, readonly } = parseRules(content);
    const targets = getTargets(event.toolName, event.arguments ?? event.input);
    for (const raw of targets) {
      const resolved = path.isAbsolute(raw)
        ? raw
        : raw.match(/^\w+:\/\//)
          ? raw
          : path.resolve(ctx.cwd, raw);

      let absAllowed = false;
      for (const aPath of allowed) {
        if (path.isAbsolute(aPath) || aPath.startsWith("~")) {
          const expanded = aPath.replace(/^~/, process.env.HOME || "").replace(/\/+$/, "");
          if (resolved === expanded || resolved.startsWith(expanded + "/")) {
            absAllowed = true;
            break;
          }
        }
      }
      if (absAllowed) continue;

      const rel = raw.match(/^\w+:\/\//)
        ? raw
        : path.relative(ctx.cwd, resolved).replace(/\\/g, "/");
      if (rel.startsWith("..")) {
        return { block: true, reason: `Attempt to access path outside repo root: ${raw}` };
      }

      for (const rPath of readonly) {
        if (matches(rel, rPath)) {
          return { block: true, reason: `${rel} is Read-Only (path-access-control.md).` };
        }
      }

      let relAllowed = false;
      for (const aPath of allowed) {
        if (matches(rel, aPath)) {
          relAllowed = true;
          break;
        }
      }

      if (!relAllowed) {
        return { block: true, reason: `${rel} is not in Allowed Paths list.` };
      }
    }
  });
}

function parseRules(content) {
  const allowed = [];
  const readonly = [];
  let section = null;

  for (const line of content.split("\n")) {
    if (line.includes("**Allowed Paths")) section = "allowed";
    else if (line.includes("**Read-Only Paths")) section = "readonly";
    else if (
      line.startsWith("**") ||
      line.startsWith("#") ||
      (line.trim() && !line.startsWith("- "))
    )
      section = null;

    if (section && line.startsWith("- ")) {
      const foundRules = line.match(/`([^`]+)`/g);
      if (foundRules) {
        for (const m of foundRules) {
          const p = m.slice(1, -1);
          if (section === "allowed") allowed.push(p);
          else if (section === "readonly") readonly.push(p);
        }
      }
    }
  }
  return { allowed, readonly };
}

function getTargets(toolName, input) {
  if (toolName === "write") {
    if (typeof input !== "object" || input === null || !("path" in input)) return [];
    const p = input.path;
    return typeof p === "string" ? [p] : [];
  }
  if (toolName === "edit") {
    if (typeof input !== "object" || input === null || !("input" in input)) return [];
    const raw = input.input;
    const targets = [];
    for (const line of String(raw).split("\n")) {
      const match = line.match(/^\[([^\]]+)#[^\]]+\]$/);
      if (match) targets.push(match[1]);
    }
    return targets;
  }
  return [];
}

function matches(target, rule) {
  if (rule === "./" || rule === ".") return !target.startsWith("..") && !path.isAbsolute(target) && !target.includes("://");
  if (rule.endsWith("/")) return target.startsWith(rule);
  return target === rule;
}
