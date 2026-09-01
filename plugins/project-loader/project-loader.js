import * as fs from "fs";
import * as path from "path";

export default function (pi) {
  pi.on("session_start", async (_event, ctx) => {
    const localDir = path.join(ctx.cwd, ".omp", "extensions");
    if (!fs.existsSync(localDir)) return;

    const files = fs.readdirSync(localDir).filter(f => f.endsWith(".js"));
    if (files.length === 0) return;

    for (const file of files) {
      try {
        const mod = await import(path.join(localDir, file));
        console.log(`[project-loader] Imported ${file}, exports: ${Object.keys(mod).join(", ") || "(empty)"}`);
        if (typeof mod.default === "function") mod.default(pi);
        if (typeof mod.onSessionStart === "function") await mod.onSessionStart(_event, ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`Project extension ${file} failed to load: ${msg}`);
      }
    }
  });
}
