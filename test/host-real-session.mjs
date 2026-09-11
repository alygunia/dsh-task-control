// Regression test for the DSH 0.1.5 session-contract break.
//
// The host half once read `agent.session.events` — a public getter on DSH
// ≤ 0.1.1-rc.2 that 0.1.5-rc.2 removed (the log is now read through
// `snapshotEvents()` / `ownEvents()` / `eventAt(seq)`). Because
// test/host-smoke.mjs used a hand-rolled `{ events: [] }` double, the suite
// stayed green while every `/pause` and `/resume` threw
// "TypeError: Cannot read properties of undefined (reading 'length')" on the
// real kernel.
//
// This file closes that gap: it drives the plugin against a REAL Session
// instance from the installed DSH, so the double can never flatter the
// implementation again.
//
// Run it with the repo's test runner (test/run.mjs) or directly:
//   node --import ./test/dsh-resolve-hook.mjs test/host-real-session.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "@deepseek-ai/dsh-session";
import { apply } from "../lib/index.js";

// Isolate the durable state store in a temp dir (hermetic, no ~/.dsh writes).
process.env.DSH_TASK_CONTROL_STATE_DIR = mkdtempSync(join(tmpdir(), "dsh-task-control-real-"));
const stateRoot = process.env.DSH_TASK_CONTROL_STATE_DIR;

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

// --- the premise of this whole file -----------------------------------------
const probe = new Session("contract-probe");
console.log("real Session exposes snapshotEvents():", typeof probe.snapshotEvents === "function");
console.log("real Session exposes ownEvents():     ", typeof probe.ownEvents === "function");
console.log("real Session exposes eventAt(seq):    ", typeof probe.eventAt === "function");
console.log("real Session 'events' property:       ", probe.events, "(absent on 0.1.5+)");
if (probe.events !== undefined) {
  throw new Error(
    "this DSH still publishes Session.events; the removed-accessor regression this suite guards no longer applies here",
  );
}

// --- a fake agent wrapping a REAL session ------------------------------------
const session = new Session("session-real");
const agent = {
  id: "session-real",
  status: "idle",
  session,
  cancelled: [],
  followups: [],
  cancel(cause, options) { this.cancelled.push({ cause, options }); },
  followup(message) { this.followups.push(message); }
};

const registered = [];
const listeners = {};
const ctx = {
  logger: { warn: (...a) => console.log("[warn]", ...a), error: (...a) => console.log("[error]", ...a) },
  get: () => undefined,
  provide(key, value) { provided[key] = value; },
  on(name, fn) { listeners[name] = fn; },
  agents: { get: (id) => (id === agent.id ? agent : undefined) },
  effect: (callback) => callback(),
  commands: { register: (definition) => registered.push(definition) }
};
const provided = {};

try {
  apply(ctx);
  const taskControl = provided.taskControl;
  const fireEvent = (event) => listeners["session/event"]({ id: agent.id }, event);

  // --- a real user prompt lands in the log through the real append ----------
  session.append("user/message", {
    id: "m1", role: "user", content: [{ type: "text", text: "real session task" }], source: { kind: "user" }
  }, { surfaceOp: "append" });

  // --- force pause while a tool runs: must NOT throw, must record the tool ---
  // This is the exact call that used to die reading `session.events.length`.
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-1", name: "bash", arguments: JSON.stringify({ command: "migrate-db", description: "真实会话迁移" }) } });
  let forcedPause;
  check("force pause on a real Session does not throw", () => {
    forcedPause = taskControl.pause(agent.id, { mode: "force" });
    if (forcedPause.ok !== true) throw new Error(`pause failed: ${JSON.stringify(forcedPause)}`);
  });
  check("force pause interrupted the running turn", () => {
    if (agent.cancelled.length !== 1) throw new Error(`expected 1 cancel, got ${agent.cancelled.length}`);
  });
  check("force pause remembered the interrupted tool", () => {
    const st = taskControl.state(agent.id);
    if (st.paused !== true || st.forced !== true) throw new Error(`state wrong: ${JSON.stringify(st)}`);
    if (st.interruptedTool?.callId !== "real-1" || st.interruptedTool?.name !== "bash") {
      throw new Error(`interruptedTool wrong: ${JSON.stringify(st.interruptedTool)}`);
    }
  });
  // lastUserPrompt must have read the REAL log (snapshotEvents), not crashed.
  check("resume source was read from the real log", () => {
    const st = taskControl.state(agent.id);
    if (st.resumeContent?.[0]?.text !== "real session task") {
      throw new Error(`resumeContent wrong: ${JSON.stringify(st.resumeContent)}`);
    }
  });

  // --- resume confirm rerun walks findToolOutcome over the real log ----------
  agent.status = "idle";
  check("unconfirmed resume still asks for confirmation", () => {
    const r = taskControl.resume(agent.id);
    if (r.ok !== false || r.needConfirmation !== true) throw new Error(`unexpected: ${JSON.stringify(r)}`);
  });
  check("confirmed resume does not throw and re-runs the interrupted tool", () => {
    const followupsBefore = agent.followups.length;
    const r = taskControl.resume(agent.id, { confirm: true });
    if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
    if (agent.followups.length !== followupsBefore + 1) throw new Error("resume did not followup");
    const text = (agent.followups.at(-1).content ?? []).map((b) => b.text ?? "").join("\n");
    if (!/重新执行/.test(text)) throw new Error(`should instruct re-execution, got: ${text}`);
  });

  // --- findToolOutcome over a real tool/result event -------------------------
  // The tool drained to completion while the pause landed: resume must NOT
  // re-run it. This exercises findToolOutcome's scan of the real log.
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-2", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/real", description: "真实会话创建文件" }) } });
  taskControl.pause(agent.id, { mode: "force" });
  session.append("tool/result", {
    turn: 1, step: 1,
    message: { id: "r2", role: "user", source: { kind: "tool", callId: "real-2" },
      content: [{ type: "tool-result", toolCallId: "real-2", content: [{ type: "text", text: "ok" }], isError: false }] }
  }, { surfaceOp: "append" });
  agent.status = "idle";
  check("a tool that drained to completion is never re-run", () => {
    const followupsBefore = agent.followups.length;
    const r = taskControl.resume(agent.id, { confirm: true });
    if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
    if (agent.followups.length !== followupsBefore + 1) throw new Error("resume did not followup");
    const text = (agent.followups.at(-1).content ?? []).map((b) => b.text ?? "").join("\n");
    if (!/已执行完成/.test(text)) throw new Error(`should report completion, got: ${text}`);
    if (/重新执行该工具/.test(text)) throw new Error("must not instruct re-execution");
  });

  // --- cancel stays independent of the log reader ---------------------------
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-3", name: "bash", arguments: JSON.stringify({ command: "rm -rf /tmp/x", description: "真实会话清理" }) } });
  check("cancel reports the interrupted tool's purpose", () => {
    const r = taskControl.cancel(agent.id);
    if (r.ok !== true) throw new Error(`cancel failed: ${JSON.stringify(r)}`);
    if (!/真实会话清理/.test(r.text)) throw new Error(`purpose missing: ${r.text}`);
  });
} finally {
  rmSync(stateRoot, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
if (failed.length > 0) {
  console.error(`\n${failed.length} REAL-SESSION CHECK(S) FAILED:`);
  for (const f of failed) console.error(` - ${f.label}: ${f.error.message}`);
  process.exitCode = 1;
} else {
  console.log("\nALL REAL-SESSION CHECKS PASSED");
}
