// Regression test for the session-contract breaks this plugin has lived through.
//
// 1. REMOVED ACCESSOR (DSH 0.1.5-rc.2).
//    The host half once read `agent.session.events` — a public getter on DSH
//    ≤ 0.1.1-rc.2 that 0.1.5-rc.2 removed (the log is now read through
//    `snapshotEvents()` / `ownEvents()` / `eventAt(seq)`). Because
//    test/host-smoke.mjs used a hand-rolled `{ events: [] }` double, the suite
//    stayed green while every `/pause` and `/resume` threw
//    "TypeError: Cannot read properties of undefined (reading 'length')" on the
//    real kernel.
//
// 2. RESHAPED EVENTS (DSH 0.2.0-rc.2).
//    The event payloads this plugin reads were restructured: `tool/result` now
//    carries a real `ToolResultMessage` (identity on `message.toolCallId` /
//    `message.source.callId`, outcome on `message.isError`) instead of nesting a
//    `tool-result` CONTENT BLOCK under `message.content`; `user/message` data IS
//    the `UserMessage`; `assistant/message` carries an `AssistantMessage` whose
//    tool calls are `tool-call` blocks. A reader hard-wired to the older nesting
//    still runs and silently mis-reads outcomes (e.g. a failed/aborted tool
//    looks successful), which is worse than throwing.
//
// So this file drives the plugin against a REAL Session instance from the
// installed DSH, and builds every event with the installed kernel's OWN
// constructors when they exist — the double can never flatter the
// implementation, and the shapes are the kernel's by construction rather than
// by transcription.
//
// Run it with the repo's test runner (test/run.mjs) or directly:
//   node --import ./test/dsh-resolve-hook.mjs test/host-real-session.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
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
const skip = (label, why) => {
  checks.push({ label, ok: true, skipped: true });
  console.log("  skip ", label, `(${why})`);
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
const metrics = (value) => (Array.isArray(value) ? `content-block[] len=${value.length}` : "message-object");
console.log("real kernel tool/result message:      ", metrics(createToolResultMessage({ callId: "probe", content: [], isError: false })?.content));
console.log("real kernel session format version:   ", probe.header?.version);

/**
 * Whether the installed kernel exposes the 0.2.0 constructors. When it does not,
 * the suite still runs — against the older nesting — so this file keeps guarding
 * both supported lines instead of silently covering one.
 */
const NEW_EVENT_SHAPES =
  typeof createToolResultMessage === "function" && typeof createAssistantMessage === "function";
console.log("event shapes under test:              ", NEW_EVENT_SHAPES ? "0.2.0 (message-carried outcome)" : "0.1.5 (nested tool-result block)");

// --- event builders: the installed kernel's shapes, by construction ---------
/**
 * Build a `tool/result` payload in the installed kernel's shape.
 *
 * 0.2.0: `{ turn, step, message: ToolResultMessage, error? }` — the outcome
 * lives on the message (`isError`), and `error` is only legal alongside a
 * failed message.
 * 0.1.5: `{ turn, step, message: { source: { callId }, content: [tool-result block] } }`.
 */
const toolResultData = (callId, { turn = 1, step = 1, text = "ok", isError = false, errorCode } = {}) => {
  const content = [{ type: "text", text }];
  if (typeof createToolResultMessage === "function") {
    return {
      turn,
      step,
      message: createToolResultMessage({ callId, content, isError }),
      ...(isError && errorCode !== undefined
        ? { error: { name: "ToolError", code: errorCode } }
        : {}),
    };
  }
  return {
    turn,
    step,
    message: {
      id: `r-${callId}`,
      role: "user",
      source: { kind: "tool", callId },
      content: [{ type: "tool-result", toolCallId: callId, content, isError }],
    },
  };
};
/** Build an `assistant/message` payload carrying the given content blocks. */
const assistantData = (content, { turn = 1, step = 1 } = {}) => ({
  turn,
  step,
  message:
    typeof createAssistantMessage === "function"
      ? createAssistantMessage({ content, source: { provider: "test", model: "test" } })
      : { id: "a-test", role: "assistant", content, source: { kind: "model", provider: "test", model: "test" } },
  ...(typeof createAssistantMessage === "function" ? { stream: [] } : {}),
});
/** Build a `user/message` payload: 0.2.0 data IS the UserMessage. */
const userData = (text) =>
  typeof createUserMessage === "function"
    ? createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } })
    : { content: [{ type: "text", text }], source: { kind: "user" } };

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

/** Run the deferred (safe-boundary) pause that lands on a microtask. */
const settleMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

try {
  apply(ctx);
  const taskControl = provided.taskControl;
  const fireEvent = (event) => listeners["session/event"]({ id: agent.id }, event);
  /** The text of the most recent resume prompt handed to the agent. */
  const lastFollowupText = () => (agent.followups.at(-1).content ?? []).map((b) => b.text ?? "").join("\n");

  // --- a real user prompt lands in the log through the real append ----------
  session.append("user/message", userData("real session task"), { surfaceOp: "append" });

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
  // lastUserPrompt must have read the REAL log, in the installed kernel's
  // `user/message` shape (0.2.0: the event data IS the UserMessage).
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
    const text = lastFollowupText();
    if (!/重新执行/.test(text)) throw new Error(`should instruct re-execution, got: ${text}`);
  });

  // --- findToolOutcome over a real tool/result event -------------------------
  // The tool drained to completion while the pause landed: resume must NOT
  // re-run it. This exercises findToolOutcome's scan of the real log.
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-2", name: "bash", arguments: JSON.stringify({ command: "touch /tmp/real", description: "真实会话创建文件" }) } });
  taskControl.pause(agent.id, { mode: "force" });
  session.append("tool/result", toolResultData("real-2", { text: "ok" }), { surfaceOp: "append" });
  agent.status = "idle";
  check("a tool that drained to completion is never re-run", () => {
    const followupsBefore = agent.followups.length;
    const r = taskControl.resume(agent.id, { confirm: true });
    if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
    if (agent.followups.length !== followupsBefore + 1) throw new Error("resume did not followup");
    const text = lastFollowupText();
    if (!/已执行完成/.test(text)) throw new Error(`should report completion, got: ${text}`);
    if (/重新执行该工具/.test(text)) throw new Error("must not instruct re-execution");
  });

  // --- a FAILED tool result must not read as success -------------------------
  // This is the 0.2.0-specific trap: the failure marker lives on the MESSAGE
  // (`isError`), not on a nested `tool-result` content block. A reader that only
  // probes the old nesting reports "already completed" here and silently skips a
  // tool that actually died mid-flight.
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-aborted", name: "bash", arguments: JSON.stringify({ command: "long-job", description: "中断的真实工具" }) } });
  taskControl.pause(agent.id, { mode: "force" });
  session.append("tool/result", toolResultData("real-aborted", { text: "aborted", isError: true, errorCode: "ABORTED" }), { surfaceOp: "append" });
  agent.status = "idle";
  check("a failed tool result is not mistaken for a completed one", () => {
    const r = taskControl.resume(agent.id, { confirm: true });
    if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
    const text = lastFollowupText();
    if (/已执行完成/.test(text)) throw new Error(`a failed tool read as completed: ${text}`);
    if (!/状态未知|重新执行/.test(text)) throw new Error(`should warn about the unknown outcome, got: ${text}`);
  });

  // --- aborted-before-dispatch has no side effects ---------------------------
  agent.status = "running";
  fireEvent({ type: "tool/call", data: { callId: "real-never", name: "bash", arguments: JSON.stringify({ command: "never-ran", description: "未派发的工具" }) } });
  taskControl.pause(agent.id, { mode: "force" });
  session.append("tool/result", toolResultData("real-never", { text: "aborted before dispatch", isError: true, errorCode: "ABORTED_BEFORE_DISPATCH" }), { surfaceOp: "append" });
  agent.status = "idle";
  if (NEW_EVENT_SHAPES) {
    check("an aborted-before-dispatch tool is reported as side-effect free", () => {
      const r = taskControl.resume(agent.id, { confirm: true, choice: "skip" });
      if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
      const text = lastFollowupText();
      if (!/未及执行/.test(text)) throw new Error(`should report it never dispatched, got: ${text}`);
    });
  } else {
    // The 0.1.5 nesting carries the outcome on the content block and its append
    // validation does not accept a top-level `error`, so the ABORTED_BEFORE_DISPATCH
    // marker cannot be injected faithfully here.
    skip("an aborted-before-dispatch tool is reported as side-effect free", "0.1.5 shape has no top-level error field");
  }

  // --- `safe wait`: deferred tool calls recorded from the assistant message ---
  // 0.2.0 assembles model tool calls as `tool-call` content blocks on the
  // AssistantMessage. With a pending `safe wait` pause, the pause lands right
  // after that reasoning and BEFORE dispatch, so those calls are recorded as
  // deferred (never dispatched, no side effects) for the resume choice.
  agent.status = "running";
  const safeWait = taskControl.pause(agent.id, { mode: "safe", reason: "wait" });
  check("safe wait pause defers until reasoning completes", () => {
    if (safeWait.ok !== true) throw new Error(`pause failed: ${JSON.stringify(safeWait)}`);
  });
  const deferredPayload = assistantData([{ type: "tool-call", id: "call-deferred", name: "bash", arguments: JSON.stringify({ command: "echo deferred", description: "待执行的工具" }) }]);
  // Append first, then deliver the LOGGED event — the kernel publishes what it
  // recorded, so the listener sees the same bytes the log holds.
  const loggedAssistant = session.append("assistant/message", deferredPayload, { surfaceOp: "append" });
  fireEvent({ type: "assistant/message", data: loggedAssistant.data });
  await settleMicrotasks();
  check("safe wait pause recorded the undispatched tool calls", () => {
    const st = taskControl.state(agent.id);
    if (st.paused !== true) throw new Error(`pause never landed: ${JSON.stringify(st)}`);
    const names = (st.deferredTools ?? []).map((tool) => tool.name);
    if (!names.includes("bash")) throw new Error(`deferredTools missing the call: ${JSON.stringify(st.deferredTools)}`);
    if ((st.deferredTools ?? [])[0]?.callId !== "call-deferred") {
      throw new Error(`deferredTools lost the call id: ${JSON.stringify(st.deferredTools)}`);
    }
  });
  check("resume asks about the deferred tools instead of silently re-running", () => {
    const r = taskControl.resume(agent.id);
    if (r.ok !== false || r.needConfirmation !== true) throw new Error(`unexpected: ${JSON.stringify(r)}`);
    if (!/工具执行前/.test(r.error ?? "")) throw new Error(`should explain the pause point, got: ${r.error}`);
  });
  check("resume with skip drops the deferred tools and continues", () => {
    const r = taskControl.resume(agent.id, { confirm: true, choice: "skip" });
    if (r.ok !== true) throw new Error(`resume failed: ${JSON.stringify(r)}`);
    const text = lastFollowupText();
    if (!/跳过/.test(text)) throw new Error(`should report the skip, got: ${text}`);
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
const skipped = checks.filter((c) => c.skipped === true);
if (failed.length > 0) {
  console.error(`\n${failed.length} REAL-SESSION CHECK(S) FAILED:`);
  for (const f of failed) console.error(` - ${f.label}: ${f.error.message}`);
  process.exitCode = 1;
} else {
  const note = skipped.length > 0 ? ` (${skipped.length} skipped on this kernel's event shape)` : "";
  console.log(`\nALL REAL-SESSION CHECKS PASSED${note}`);
}
