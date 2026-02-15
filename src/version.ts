/**
 * Version information for WHS CLI
 */

import { statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// Read version from package.json at build time would require bundling
// Instead, we hardcode it here and keep it in sync with package.json
export const VERSION = "0.14.0";

/**
 * Get the build timestamp (mtime of the compiled cli.js)
 */
export function getBuildTime(): Date | null {
  try {
    // Get the directory of this file (works in both src and dist)
    const thisFile = fileURLToPath(import.meta.url);
    const distDir = dirname(thisFile);
    const cliPath = join(distDir, "cli.js");

    const stats = statSync(cliPath);
    return stats.mtime;
  } catch {
    return null;
  }
}

/**
 * Format build time for display
 */
export function formatBuildTime(): string {
  const buildTime = getBuildTime();
  if (!buildTime) return "unknown";

  // Format as "2025-02-07 08:15:32"
  return buildTime.toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Get full version string with build time
 */
export function getVersionString(): string {
  return `v${VERSION} (built ${formatBuildTime()})`;
}
