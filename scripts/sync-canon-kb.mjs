// Synchronizes canon/indicator/kb-v4.json from xauusd-ai-trading-assistant/knowledge-base-v4.json.
// Compares raw SHA-256 hashes:
//   - If identical: reports up-to-date and exits 0 (or exits 0 in --check mode).
//   - If different: copies file to canon/indicator/kb-v4.json and executes npm run canon:build (or exits 1 in --check mode).
// AGENTS.md compliance:
//   - KB v4 is imported from xauusd as is and never edited here.
//   - Aether never writes to xauusd (read-only from xauusd).
//   - Canon changes only by a reviewed PR.
import { createHash } from "node:crypto";
import { readFileSync, copyFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_SOURCE = path.resolve(ROOT, "../xauusd-ai-trading-assistant/knowledge-base-v4.json");
export const TARGET_PATH = path.resolve(ROOT, "canon/indicator/kb-v4.json");

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function syncCanonKb({
  sourcePath = process.env.XAUUSD_KB_PATH || DEFAULT_SOURCE,
  targetPath = TARGET_PATH,
  checkOnly = false,
  execBuild = true,
} = {}) {
  const resolvedSource = path.resolve(sourcePath);
  const resolvedTarget = path.resolve(targetPath);

  if (!existsSync(resolvedSource)) {
    throw new Error(`Source knowledge-base file not found: ${resolvedSource}`);
  }

  const srcBytes = readFileSync(resolvedSource);
  const srcSha = sha256(srcBytes);

  let dstSha = null;
  if (existsSync(resolvedTarget)) {
    const dstBytes = readFileSync(resolvedTarget);
    dstSha = sha256(dstBytes);
  }

  if (srcSha === dstSha) {
    console.log(`canon/indicator/kb-v4.json is already up to date (${srcSha})`);
    return { status: "up_to_date", sha256: srcSha, sourcePath: resolvedSource, targetPath: resolvedTarget };
  }

  if (checkOnly) {
    console.error(`canon/indicator/kb-v4.json is stale: target (${dstSha ?? "none"}) != source (${srcSha})`);
    return { status: "stale", oldSha: dstSha, newSha: srcSha, sourcePath: resolvedSource, targetPath: resolvedTarget };
  }

  console.log(`Syncing kb-v4: ${dstSha ? dstSha.slice(0, 12) + "..." : "none"} -> ${srcSha.slice(0, 12)}...`);
  copyFileSync(resolvedSource, resolvedTarget);
  console.log(`Copied ${resolvedSource} -> ${resolvedTarget}`);

  if (execBuild) {
    console.log("Running npm run canon:build...");
    execSync("npm run canon:build", { cwd: ROOT, stdio: "inherit" });
  }

  return { status: "synced", oldSha: dstSha, newSha: srcSha, sourcePath: resolvedSource, targetPath: resolvedTarget };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/sync-canon-kb.mjs [source_path] [--check]");
    console.log("Synchronizes canon/indicator/kb-v4.json from source knowledge-base-v4.json.");
    console.log("Defaults to ../xauusd-ai-trading-assistant/knowledge-base-v4.json or XAUUSD_KB_PATH.");
    process.exit(0);
  }

  const checkOnly = process.argv.includes("--check");
  const customSource = process.argv.slice(2).find((arg) => !arg.startsWith("--"));
  try {
    const res = syncCanonKb({ sourcePath: customSource, checkOnly });
    if (checkOnly && res.status === "stale") {
      process.exit(1);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
