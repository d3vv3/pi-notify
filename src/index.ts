import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { configPath, isQuiet, loadConfig, parseConfig, type Config, type Kind } from "./config.js";
import { isFocused, sendDesktop, terminalApp } from "./backend.js";

interface Dependencies {
  load: () => Promise<Config>;
  send: (kind: Kind, config: Config, cwd: string) => Promise<void>;
  focused: (app: string | undefined) => Promise<boolean>;
  platform: NodeJS.Platform;
}

export function registerNotify(pi: ExtensionAPI, overrides: Partial<Dependencies> = {}): void {
  const deps: Dependencies = { load: loadConfig, send: sendDesktop, focused: isFocused, platform: process.platform, ...overrides };
  let config = parseConfig({});
  let outcome = "completed";
  let running = false;
  let stopped = false;
  const warnings = new Set<string>();
  const questionCalls = new Set<string>();
  const permissionRequests = new Set<string>();
  let sessionContext: ExtensionContext | undefined;

  // The permission system can render its own UI rather than ctx.ui.confirm.
  pi.events.on("permissions:ui_prompt", (data: unknown) => {
    if (!sessionContext || !running || !data || typeof data !== "object") return;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (typeof requestId !== "string" || permissionRequests.has(requestId)) return;
    permissionRequests.add(requestId);
    void notify("permission", sessionContext);
  });
  pi.events.on("permissions:decision", (data: unknown) => {
    if (!data || typeof data !== "object") return;
    const requestId = (data as { requestId?: unknown }).requestId;
    if (typeof requestId === "string") permissionRequests.delete(requestId);
  });

  function warn(ctx: ExtensionContext, message: string): void {
    if (warnings.has(message)) return;
    warnings.add(message);
    if (ctx.hasUI) ctx.ui.notify(`pi-notify: ${message}`, "warning");
    else console.warn(`pi-notify: ${message}`);
  }

  async function notify(kind: Kind, ctx: ExtensionContext, force = false): Promise<void> {
    if (stopped || ctx.mode !== "tui") return;
    if (!force && (!config.enabled || isQuiet(config))) return;
    try {
      if (!force && kind !== "question" && kind !== "permission" && config.suppressWhenFocused && deps.platform === "darwin") {
        let focused = false;
        try { focused = await deps.focused(config.terminal ?? terminalApp()); }
        catch { warn(ctx, "Could not detect terminal focus; sending notifications anyway."); }
        if (focused) return;
      }
      if (!stopped) await deps.send(kind, config, ctx.cwd);
    } catch {
      warn(ctx, "Notification or audio playback failed. Check the platform requirements in README.md.");
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    stopped = false;
    sessionContext = ctx;
    permissionRequests.clear();
    running = false;
    outcome = "completed";
    warnings.clear();
    questionCalls.clear();
    try { config = await deps.load(); }
    catch {
      config = parseConfig({ enabled: false });
      warn(ctx, `Invalid configuration at ${configPath()}; notifications disabled. Fix it and /reload.`);
    }
  });
  pi.on("agent_start", () => { running = true; outcome = "completed"; questionCalls.clear(); });
  // This boundary carries the final run outcome; agent_end may precede retries.
  pi.on("agent_before_settle", (event) => { outcome = event.outcome; });
  pi.on("agent_settled", (event, ctx) => {
    const shouldNotify = running && !event.aborted && outcome !== "aborted";
    running = false;
    questionCalls.clear();
    permissionRequests.clear();
    if (shouldNotify) void notify(outcome === "error" ? "error" : "idle", ctx);
  });
  pi.on("tool_call", (event, ctx) => {
    if (!running || !/(?:^|__|[.:/])(?:ask_user_question|question)$/.test(event.toolName)) return;
    if (questionCalls.has(event.toolCallId)) return;
    questionCalls.add(event.toolCallId);
    void notify("question", ctx);
  });
  pi.on("tool_result", (event) => { questionCalls.delete(event.toolCallId); });
  pi.on("ui_prompt_start", (event, ctx) => {
    // Only agent-related dialogs need attention alerts, not startup/reload UI.
    if (!running || permissionRequests.size > 0) return;
    // A question tool may also use ctx.ui; its tool_call already sent the alert.
    if (event.kind !== "confirm" && questionCalls.size > 0) return;
    void notify(event.kind === "confirm" ? "permission" : "question", ctx);
  });
  pi.on("session_shutdown", () => { stopped = true; running = false; questionCalls.clear(); permissionRequests.clear(); sessionContext = undefined; });

  pi.registerCommand("notify", {
    description: "Desktop notifications: status, on, off, test [idle|error|permission|question]",
    handler: async (args, ctx) => {
      const [action = "status", kind = "idle", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (action === "on" || action === "off") {
        config.enabled = action === "on";
        ctx.ui.notify(`pi-notify ${config.enabled ? "enabled" : "disabled"} for this session`, "info");
      } else if (action === "status") {
        ctx.ui.notify(`pi-notify: ${config.enabled ? "on" : "off"} · ${basename(ctx.cwd)} · config: ${configPath()}`, "info");
      } else if (action === "test" && ["idle", "error", "permission", "question"].includes(kind) && rest.length === 0) {
        await notify(kind as Kind, ctx, true);
      } else {
        ctx.ui.notify("Usage: /notify [status|on|off|test [idle|error|permission|question]]", "warning");
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  registerNotify(pi);
}
