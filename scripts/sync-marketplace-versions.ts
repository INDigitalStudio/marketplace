import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface MarketplacePlugin {
  name: string;
  source: string;
  version: string;
  [key: string]: unknown;
}

interface Marketplace {
  plugins: MarketplacePlugin[];
  [key: string]: unknown;
}

const marketplacePath = join(process.cwd(), "marketplace.json");
const marketplace: Marketplace = JSON.parse(readFileSync(marketplacePath, "utf-8"));

let updated = 0;
for (const plugin of marketplace.plugins) {
  if (!plugin.source) continue;
  const pkgPath = join(process.cwd(), plugin.source, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (pkg.version && pkg.version !== plugin.version) {
      console.log(`Updating ${plugin.name} in marketplace.json: ${plugin.version} -> ${pkg.version}`);
      plugin.version = pkg.version;
      updated++;
    }
  } catch {
    // Skip plugins without package.json (e.g. standalone skill directories)
  }
}

if (updated > 0) {
  writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + "\n");
  console.log(`Synced ${updated} plugin version(s) in marketplace.json`);
} else {
  console.log("All marketplace.json versions already match package.json");
}
