// Regression test for the DSH 0.2.0 plugin-compatibility gate.
//
// DSH 0.2.0 judges a plugin BEFORE loading any of its code: app-boot's
// evaluatePluginCompatibility() reads package.json peerDependencies, keeps only
// the names `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`, and requires
// semver.satisfies(runtimeVersion, range, { includePrerelease: true }). An
// incompatible peer set makes the plugin manager refuse the plugin with
// `incompatible-version` ("Plugin <name>@<version> is incompatible with dsh
// <runtime>: peerDependencies {...}"), unless someone grants a per-version
// exemption.
//
// That is exactly how this plugin broke on 0.2.0: every dsh peer was pinned to
// `^0.1.5-rc.2`, and for a 0.x version a caret pins the MINOR line, so
// `^0.1.5-rc.2` means `>=0.1.5-rc.2 <0.2.0` and 0.2.0-rc.2 falls outside it.
//
// This suite calls the INSTALLED kernel's own evaluator, so the assertion
// cannot drift from the running rule the way a re-implemented copy would. It
// asserts compatibility on both supported lines and then proves the check has
// teeth by re-running it against the pre-fix range.
//
// Run it with the repo's test runner (test/run.mjs).
import { readFileSync } from "node:fs";
import { evaluatePluginCompatibility, getDshRuntimeVersion } from "@deepseek-ai/dsh-app-boot";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
/** The 0.1.5 line this plugin also supports (its pre-0.2.0 deployment target). */
const LEGACY_RUNTIME = "0.1.5-rc.2";

const checks = [];
const check = (label, fn) => {
  try {
    fn();
    checks.push({ label, ok: true });
    console.log("  ok   ", label);
  } catch (error) {
    checks.push({ label, ok: false, error });
    console.log("  FAIL ", label, "->", error.message);
  }
};

const runtime = getDshRuntimeVersion();
console.log(`plugin compatibility suite: ${manifest.name}@${manifest.version} vs dsh ${runtime}`);
console.log(`  (also asserted against the legacy line dsh ${LEGACY_RUNTIME})`);

/** The dsh-peer ranges the rule actually enforces (name filter mirrors app-boot). */
const dshPeers = Object.entries(manifest.peerDependencies ?? {})
  .filter(([name]) => name === "@deepseek-ai/dsh" || name.startsWith("@deepseek-ai/dsh-"));
console.log(`  ${dshPeers.length} dsh peer range(s) under the compatibility rule`);

check("the manifest is compatible with the installed dsh runtime", () => {
  const issue = evaluatePluginCompatibility(manifest, {}, runtime);
  if (issue !== undefined) {
    throw new Error(
      `app-boot rejects this plugin on dsh ${runtime}: ${JSON.stringify(issue.peers)}`,
    );
  }
});

check("the manifest is still compatible with the legacy dsh 0.1.5 line", () => {
  const issue = evaluatePluginCompatibility(manifest, {}, LEGACY_RUNTIME);
  if (issue !== undefined) {
    throw new Error(
      `this revision claims 0.1.5 support but app-boot rejects it on ${LEGACY_RUNTIME}: ${JSON.stringify(issue.peers)}`,
    );
  }
});

// The guard's guard: if the rule ever stops reading dsh peers (or the helper is
// swapped for a moot one), the two assertions above would pass vacuously. Feed
// it the pre-fix manifest and require a rejection.
check("the compatibility rule still rejects the pre-fix ^0.1.5-rc.2-only pins", () => {
  const conflicting = {
    ...manifest,
    peerDependencies: Object.fromEntries(dshPeers.map(([name]) => [name, "^0.1.5-rc.2"])),
  };
  const issue = evaluatePluginCompatibility(conflicting, {}, runtime);
  if (issue === undefined) {
    throw new Error(
      `app-boot accepted ^0.1.5-rc.2 on dsh ${runtime}; this suite would no longer detect the 0.2.0 gate`,
    );
  }
});

check("every dsh peer range admits the installed runtime", () => {
  const conflicting = {
    ...manifest,
    peerDependencies: Object.fromEntries(dshPeers.map(([name, range]) => [name, range])),
  };
  const issue = evaluatePluginCompatibility(conflicting, {}, runtime);
  if (issue !== undefined) {
    throw new Error(`peer range(s) exclude dsh ${runtime}: ${JSON.stringify(issue.peers)}`);
  }
});

// --- bundle / client manifest shape the profile loader reads -----------------
check("the bundle patch the profile loader reads is declared and present", () => {
  const patch = manifest.dsh?.bundle?.patch;
  if (typeof patch !== "string" || patch.length === 0) {
    throw new Error("package.json dsh.bundle.patch is missing");
  }
  readFileSync(new URL(`../${patch.replace(/^\.\//, "")}`, import.meta.url), "utf8");
});

check("the browser half is declared for the web platform", () => {
  const client = manifest.dsh?.client;
  if (client?.platform !== "web") {
    throw new Error(`package.json dsh.client.platform must be "web", got ${JSON.stringify(client?.platform)}`);
  }
  if (!Array.isArray(client.inject) || client.inject.length === 0) {
    throw new Error("package.json dsh.client.inject must list the client packages this half needs");
  }
  if (manifest.exports?.["./client"] === undefined) {
    throw new Error('package.json exports["./client"] must point at the browser half');
  }
});

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} COMPATIBILITY CHECK(S) FAILED:`);
  for (const f of failed) console.error(` - ${f.label}: ${f.error.message}`);
  process.exitCode = 1;
} else {
  console.log(`\nALL COMPATIBILITY CHECKS PASSED (dsh ${runtime} + ${LEGACY_RUNTIME})`);
}
