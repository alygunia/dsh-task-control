// Test runner for dsh-task-control's host half.
//
// The plugin imports `@deepseek-ai/dsh-llm` (and the real-session suite imports
// `@deepseek-ai/dsh-session`), which only exist inside a DSH installation — not
// in this repo. The runner locates the installed profile's node_modules, runs
// each suite in a child process with a small ESM resolve hook that redirects
// `@deepseek-ai/*` there, and reports one exit code for the whole suite.
//
// Usage:
//   node test/run.mjs
//   DSH_PROFILE_MODULES=/path/to/profiles/node_modules node test/run.mjs
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const suites = ["plugin-compatibility.mjs", "host-smoke.mjs", "host-real-session.mjs"];

/** Candidate `profiles/node_modules` roots, most specific first. */
function candidateModuleRoots() {
  const roots = [];
  if (process.env.DSH_PROFILE_MODULES !== undefined && process.env.DSH_PROFILE_MODULES.length > 0) {
    roots.push(process.env.DSH_PROFILE_MODULES);
  }
  const home = process.env.DSH_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".dsh");
  let profiles = [];
  try {
    profiles = readdirSync(join(home, "profiles"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // No profiles directory: fall through to the flat and repo-local candidates.
  }
  // The web profile is the plugin's target; then everything else, then the
  // flat profile node_modules the CLI creates, then the repo's own (usually
  // symlinked) node_modules.
  for (const name of ["web", ...profiles]) roots.push(join(home, "profiles", name, "node_modules"));
  roots.push(join(home, "profiles", "node_modules"));
  roots.push(join(repoRoot, "node_modules"));
  return [...new Set(roots)];
}

/** The first candidate that can actually resolve the host kernel package. */
function findModuleRoot() {
  return candidateModuleRoots().find(
    (root) => existsSync(join(root, "@deepseek-ai", "dsh-llm", "package.json")),
  );
}

/**
 * Write the ESM hook pair that redirects `@deepseek-ai/*` to `moduleRoot`.
 *
 * A module's static imports are resolved BEFORE the entry module body runs, and
 * `--import` preloads are linked before the entry file — so a preload that only
 * *registers* a hook is too late for the suite's own static imports. The
 * register file therefore registers the hook and then imports the suite
 * dynamically, which happens after the hook is live.
 */
function writeResolveHook(dir, moduleRoot, suitePath) {
  const resolverPath = join(dir, "resolve-hook.mjs");
  const registerPath = join(dir, "register-hook.mjs");
  writeFileSync(resolverPath, `
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(${JSON.stringify(join(moduleRoot, "noop.cjs"))});
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    try {
      return { url: pathToFileURL(require.resolve(specifier)).href, shortCircuit: true };
    } catch {
      // Not installed there: fall through to normal resolution.
    }
  }
  return next(specifier, context);
}
`, "utf8");
  // The suite path is baked in (process.argv is not usable from a --import
  // preload), and the import is dynamic so it resolves only after the hook
  // above is installed — a module's static imports are linked before the entry
  // module body runs, so a preload that merely registers a hook would be too late.
  writeFileSync(registerPath, `
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
register(${JSON.stringify(pathToFileURL(resolverPath).href)});
await import(${JSON.stringify(pathToFileURL(suitePath).href)});
`, "utf8");
  return registerPath;
}

const moduleRoot = findModuleRoot();
if (moduleRoot === undefined) {
  console.error(
    "test/run.mjs: could not find an installed DSH to resolve @deepseek-ai/* from.\n"
    + "Tried:\n" + candidateModuleRoots().map((r) => `  - ${r}`).join("\n") + "\n"
    + "Set DSH_PROFILE_MODULES to a profiles/node_modules directory containing @deepseek-ai/dsh-llm.",
  );
  process.exit(2);
}
console.log(`resolving @deepseek-ai/* from ${moduleRoot}`);

const hookDir = mkdtempSync(join(tmpdir(), "dsh-task-control-test-"));
let failures = 0;
try {
  for (const name of suites) {
    const file = join(here, name);
    console.log(`\n=== ${name} ===`);
    if (!existsSync(file)) {
      console.log("(missing, skipped)");
      continue;
    }
    const hookPath = writeResolveHook(hookDir, moduleRoot, file);
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(hookPath).href],
      { stdio: "inherit", cwd: repoRoot, env: process.env },
    );
    if (result.status !== 0) failures += 1;
  }
} finally {
  rmSync(hookDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} test suite(s) FAILED`);
  process.exit(1);
}
console.log("\nall host-half suites passed");
