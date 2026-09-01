import { execSync } from "child_process";

let synced = false;

function isGitRepo(cwd) {
  try {
    execSync("git rev-parse --git-dir", { cwd, stdio: "pipe" });
    return true;
  } catch (_) {
    return false;
  }
}

function doSync(cwd) {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  let result = "";
  let stashUsed = false;
  try {
    const status = execSync("git status --porcelain", { cwd, stdio: "pipe" }).toString().trim();
    if (status) {
      stashUsed = true;
      execSync("git stash -u -m 'git-sync'", { cwd, stdio: "pipe" });
    }
    execSync("git pull --rebase", { cwd, stdio: "pipe" });
    if (stashUsed) {
      try { execSync("git stash pop --quiet", { cwd, stdio: "pipe" }); } catch (_) { result = `Synced but stash pop conflicted: resolve manually`; }
    }
    if (!stashUsed || !result) result = `Synced at ${stamp}${stashUsed ? " (changes preserved)" : ""}`;
    synced = true;
  } catch (e) {
    try { execSync("git rebase --abort", { cwd, stdio: "pipe" }); } catch (_) {}
    if (stashUsed) {
      try { execSync("git stash pop --quiet", { cwd, stdio: "pipe" }); } catch (_) {
        result = `Sync failed: ${e.message.split('\n')[0]}; stash remains`;
      }
    }
    if (!result) result = `Sync failed: ${e.message.split('\n')[0]}`;
  }
  console.log(`[git-sync] ${result}`);
}

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    if (synced) return;
    if (!isGitRepo(ctx.cwd)) return;
    doSync(ctx.cwd);
  });
}
