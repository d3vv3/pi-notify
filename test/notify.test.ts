import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename, isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseConfig, isQuiet, loadConfig, type Kind } from "../src/config.js";
import { sendDesktop, isFocused, appleString } from "../src/backend.js";
import { registerNotify } from "../src/index.js";

test("defaults resolve to bundled WAV files independent of the working directory", async () => {
  const sounds = parseConfig({}).sounds;
  const expected = { idle: "complete.wav", error: "error.wav", permission: "permission.wav", question: "question.wav" };
  for (const kind of Object.keys(expected) as Kind[]) {
    const path = sounds[kind];
    assert.equal(typeof path, "string");
    assert.ok(isAbsolute(path as string));
    assert.equal(basename(path as string), expected[kind]);
    const data = await readFile(path as string);
    assert.equal(data.toString("ascii", 0, 4), "RIFF");
    assert.equal(data.toString("ascii", 8, 12), "WAVE");
  }
});

test("sound overrides preserve distinct question default and inherit explicit permission override", () => {
  assert.match(parseConfig({ sounds: {} }).sounds.question as string, /question\.wav$/);
  assert.equal(parseConfig({ sounds: { permission: "Ping" } }).sounds.question, "Ping");
  assert.equal(parseConfig({ sounds: { idle: false } }).sounds.idle, false);
});

test("reject malformed configuration instead of silently enabling defaults", () => {
  for (const value of [null, [], { enabled: "yes" }, { sounds: { idle: 1 } }, { quietHours: { start: "24:00" } }, { quietHours: { end: "8:00" } }]) {
    assert.throws(() => parseConfig(value));
  }
});

test("missing file uses defaults; malformed file fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-notify-test-"));
  try {
    const path = join(dir, "config.json");
    assert.equal((await loadConfig(path)).enabled, true);
    await writeFile(path, "{invalid");
    await assert.rejects(loadConfig(path));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("quiet hours handle daytime, overnight, exclusive end and equal bounds", () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 0, 1, hours, minutes);
  const overnight = parseConfig({ quietHours: { enabled: true } });
  assert.equal(isQuiet(overnight, at(22)), true);
  assert.equal(isQuiet(overnight, at(7, 59)), true);
  assert.equal(isQuiet(overnight, at(8)), false);
  assert.equal(isQuiet(overnight, at(12)), false);
  const daytime = parseConfig({ quietHours: { enabled: true, start: "09:00", end: "17:00" } });
  assert.equal(isQuiet(daytime, at(9)), true);
  assert.equal(isQuiet(daytime, at(17)), false);
  assert.equal(isQuiet(parseConfig({ quietHours: { enabled: true, start: "09:00", end: "09:00" } }), at(9)), false);
});

test("macOS notification uses exact system sound names and escapes AppleScript text", async () => {
  const calls: [string, string[]][] = [];
  await sendDesktop("idle", parseConfig({ sounds: { idle: "Glass" } }), '/work/a"b\\c', "darwin", async (cmd, args) => { calls.push([cmd, args]); return ""; });
  assert.equal(calls[0][0], "osascript");
  assert.match(calls[0][1][1], /sound name "Glass"$/);
  assert.match(calls[0][1][1], /a\\"b\\\\c/);
  assert.equal(appleString('a\nb'), '"a b"');
});

test("Linux plays bundled defaults, supports custom paths, and can mute audio", async () => {
  const calls: [string, string[]][] = [];
  const execute = async (cmd: string, args: string[]) => { calls.push([cmd, args]); return ""; };
  await sendDesktop("error", parseConfig({}), "/tmp/$(touch nope)", "linux", execute);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], "paplay");
  assert.match(calls[1][1][0], /sounds\/error\.wav$/);
  assert.equal(calls[0][0], "notify-send");
  assert.ok(calls[0][1].includes("--urgency=critical"));
  assert.ok(calls[0][1].includes("--"));
  calls.length = 0;
  await sendDesktop("question", parseConfig({ sounds: { question: "/tmp/a b.wav" } }), "/tmp/project", "linux", execute);
  assert.deepEqual(calls[1], ["paplay", ["/tmp/a b.wav"]]);
  calls.length = 0;
  await sendDesktop("idle", parseConfig({ sounds: { idle: false } }), "/tmp", "linux", execute);
  assert.equal(calls.length, 1);
  await assert.rejects(sendDesktop("idle", parseConfig({}), "/tmp", "linux", async () => { throw new Error("missing executable"); }));
});

test("macOS plays bundled audio with afplay without requesting a named system sound", async () => {
  const calls: [string, string[]][] = [];
  await sendDesktop("question", parseConfig({}), "/work/project", "darwin", async (cmd, args) => { calls.push([cmd, args]); return ""; });
  assert.doesNotMatch(calls[0][1][1], /sound name/);
  assert.equal(calls[1][0], "afplay");
  assert.match(calls[1][1][0], /sounds\/question\.wav$/);
});

test("macOS focus matching is case insensitive", async () => {
  assert.equal(await isFocused("Ghostty", async () => "ghostty"), true);
  assert.equal(await isFocused(undefined, async () => { throw new Error("must not run"); }), false);
});

function harness(options: { focused?: boolean; fail?: boolean; config?: unknown; mode?: string } = {}) {
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
  const commands = new Map<string, any>();
  const bus = new Map<string, (data: unknown) => void>();
  const sent: Kind[] = [];
  const warnings: string[] = [];
  const ctx = { cwd: "/work/project", mode: options.mode ?? "tui", hasUI: true, ui: { notify: (text: string) => warnings.push(text) } } as unknown as ExtensionContext;
  const pi = { events: { on: (name: string, handler: (data: unknown) => void) => { bus.set(name, handler); return () => bus.delete(name); } }, on: (name: string, handler: any) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command) } as unknown as ExtensionAPI;
  registerNotify(pi, {
    load: async () => parseConfig(options.config ?? {}),
    send: async (kind) => { if (options.fail) throw new Error("backend failed"); sent.push(kind); },
    focused: async () => options.focused ?? false,
    platform: "darwin",
  });
  return { sent, warnings, emit: async (name: string, data: unknown) => { bus.get(name)?.(data); await new Promise<void>((resolve) => setImmediate(resolve)); }, fire: async (name: string, event = {}) => { await handlers.get(name)?.(event, ctx); await new Promise<void>((resolve) => setImmediate(resolve)); }, command: async (args: string) => commands.get("notify").handler(args, ctx) };
}

test("notify only at final settlement, once, not at intermediate agent_end", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("agent_end");
  assert.deepEqual(h.sent, []);
  await h.fire("agent_before_settle", { outcome: "completed" });
  await h.fire("agent_settled", { aborted: false });
  await h.fire("agent_settled", { aborted: false });
  assert.deepEqual(h.sent, ["idle"]);
});

test("final error uses error sound category; aborted runs stay silent", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("agent_before_settle", { outcome: "error" });
  await h.fire("agent_settled", { aborted: false });
  await h.fire("agent_start");
  await h.fire("agent_settled", { aborted: true });
  assert.deepEqual(h.sent, ["error"]);
});

test("startup, reload and idle dialogs stay silent; active agent input requests notify", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.fire("ui_prompt_start", { kind: "custom" });
  await h.fire("ui_prompt_start", { kind: "confirm" });
  assert.deepEqual(h.sent, []);
  await h.fire("agent_start");
  for (const kind of ["select", "confirm", "input", "editor", "custom"]) {
    await h.fire("ui_prompt_start", { kind });
  }
  assert.deepEqual(h.sent, ["question", "permission", "question", "question", "question"]);
  await h.fire("session_shutdown");
  await h.fire("session_start");
  await h.fire("ui_prompt_start", { kind: "custom" });
  await h.fire("agent_settled", { aborted: false });
  assert.equal(h.sent.length, 5);
});

test("question tools notify once and deduplicate their UI dialogs", async () => {
  const h = harness({ focused: true });
  await h.fire("session_start");
  await h.fire("tool_call", { toolName: "ask_user_question", toolCallId: "idle" });
  assert.deepEqual(h.sent, []);
  await h.fire("agent_start");
  for (const toolName of ["ask_user_question", "functions.ask_user_question", "mcp__server__ask_user_question", "question"]) {
    await h.fire("tool_call", { toolName, toolCallId: toolName });
    await h.fire("tool_call", { toolName, toolCallId: toolName });
    await h.fire("ui_prompt_start", { kind: "custom" });
    await h.fire("tool_result", { toolCallId: toolName });
  }
  assert.deepEqual(h.sent, ["question", "question", "question", "question"]);
  await h.fire("tool_call", { toolName: "write", toolCallId: "write" });
  await h.fire("ui_prompt_start", { kind: "input" });
  assert.equal(h.sent.length, 5);
});

test("permission-system prompts notify while focused, deduplicate UI, and ignore lifecycle chatter", async () => {
  const h = harness({ focused: true });
  await h.fire("session_start");
  await h.emit("permissions:ui_prompt", { requestId: "startup" });
  await h.fire("agent_start");
  await h.emit("permissions:ui_prompt", null);
  await h.emit("permissions:ui_prompt", {});
  await h.emit("permissions:ui_prompt", { requestId: "one" });
  await h.emit("permissions:ui_prompt", { requestId: "one" });
  await h.fire("ui_prompt_start", { kind: "custom" });
  assert.deepEqual(h.sent, ["permission"]);
  await h.emit("permissions:decision", { requestId: "one" });
  await h.fire("ui_prompt_start", { kind: "select" });
  assert.deepEqual(h.sent, ["permission", "question"]);
  await h.fire("session_shutdown");
  await h.emit("permissions:ui_prompt", { requestId: "shutdown" });
  assert.equal(h.sent.length, 2);
});

test("questions and confirmations bypass focus suppression while completion does not", async () => {
  const h = harness({ focused: true });
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("ui_prompt_start", { kind: "confirm" });
  await h.fire("ui_prompt_start", { kind: "select" });
  await h.fire("agent_start");
  await h.fire("agent_settled", { aborted: false });
  assert.deepEqual(h.sent, ["permission", "question"]);
});

test("session toggles suppress notifications; explicit tests bypass suppression", async () => {
  const h = harness();
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.command("off");
  await h.fire("ui_prompt_start", { kind: "confirm" });
  assert.deepEqual(h.sent, []);
  await h.command("test permission");
  await h.command("on");
  await h.fire("ui_prompt_start", { kind: "confirm" });
  assert.deepEqual(h.sent, ["permission", "permission"]);
});

test("quiet hours and noninteractive sessions are silent", async () => {
  const now = new Date();
  const time = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  const minute = now.getHours() * 60 + now.getMinutes();
  for (const options of [{ mode: "json" }, { config: { quietHours: { enabled: true, start: time((minute + 1439) % 1440), end: time((minute + 2) % 1440) } } }]) {
    const h = harness(options);
    await h.fire("session_start");
    await h.fire("agent_start");
    await h.fire("ui_prompt_start", { kind: "input" });
    assert.deepEqual(h.sent, []);
  }
});

test("backend failures warn once without breaking the agent; shutdown stops delivery", async () => {
  const h = harness({ fail: true });
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("ui_prompt_start", { kind: "input" });
  await h.fire("ui_prompt_start", { kind: "input" });
  assert.equal(h.warnings.length, 1);
  const active = harness();
  await active.fire("session_start");
  await active.fire("session_shutdown");
  await active.command("test");
  assert.deepEqual(active.sent, []);
});

test("invalid config disables automatic notifications and surfaces a warning", async () => {
  const h = harness({ config: { enabled: "wrong" } });
  await h.fire("session_start");
  await h.fire("agent_start");
  await h.fire("ui_prompt_start", { kind: "input" });
  assert.deepEqual(h.sent, []);
  assert.match(h.warnings[0], /Invalid configuration/);
});
