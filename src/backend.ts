import { execFile } from "node:child_process";
import { isAbsolute, basename } from "node:path";
import notifier from "node-notifier";
import type { Config, Kind } from "./config.js";

export type Run = (command: string, args: string[]) => Promise<string>;
export const run: Run = (command, args) => new Promise((resolve, reject) => {
  execFile(command, args, { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(new Error(`${command} failed (${(error as NodeJS.ErrnoException).code ?? "unknown"})`));
    else resolve(stdout.trim());
  });
});

// AppleScript string literals, not shell interpolation.
export function appleString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]/g, " ")}"`;
}

export function terminalApp(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const apps: Record<string, string> = {
    Apple_Terminal: "Terminal", iTerm: "iTerm2", "iTerm.app": "iTerm2",
    ghostty: "Ghostty", WezTerm: "WezTerm", vscode: "Code", Hyper: "Hyper", WarpTerminal: "Warp",
  };
  if (env.KITTY_PID) return "kitty";
  return apps[env.TERM_PROGRAM ?? ""];
}

export async function isFocused(app: string | undefined, execute: Run = run): Promise<boolean> {
  if (!app) return false;
  const front = await execute("osascript", ["-e", 'tell application "System Events" to get name of first application process whose frontmost is true']);
  return front.toLowerCase() === app.toLowerCase();
}

export const titles: Record<Kind, string> = {
  idle: "Ready for review", error: "Something went wrong", permission: "Waiting for you", question: "Question for you",
};

export async function sendDesktop(
  kind: Kind, config: Config, cwd: string,
  platform: NodeJS.Platform = process.platform, execute: Run = run,
): Promise<void> {
  const title = `Pi · ${titles[kind]}`;
  // No prompt, tool arguments, or provider error text is exposed on the lock screen.
  const descriptions: Record<Kind, string> = {
    idle: "Task finished", error: "The agent stopped with an error",
    permission: "Pi needs your input", question: "Pi needs your input",
  };
  const message = `${basename(cwd) || "Pi"}: ${descriptions[kind]}`;
  const sound = config.sounds[kind];
  if (platform === "darwin") {
    const namedSound = sound && !isAbsolute(sound) ? ` sound name ${appleString(sound)}` : "";
    await execute("osascript", ["-e", `display notification ${appleString(message)} with title ${appleString(title)}${namedSound}`]);
    if (sound && isAbsolute(sound)) await execute("afplay", [sound]);
  } else if (platform === "linux") {
    await execute("notify-send", ["--app-name=Pi", `--urgency=${kind === "error" ? "critical" : "normal"}`, "--hint=boolean:suppress-sound:true", "--", title, message]);
    // Apple system sounds are not shipped on Linux. Only explicitly supplied files are played.
    if (sound && isAbsolute(sound)) await execute("paplay", [sound]);
  } else if (platform === "win32") {
    if (sound && isAbsolute(sound) && !sound.toLowerCase().endsWith(".wav")) throw new Error("Windows custom sounds require a WAV file");
    await new Promise<void>((resolve, reject) => {
      notifier.notify({ title, message, sound: Boolean(sound && !isAbsolute(sound)), wait: false, timeout: 5 }, (error) => {
        if (error) reject(new Error("Windows desktop notification failed"));
        else resolve();
      });
    });
    if (sound && isAbsolute(sound)) {
      const literal = sound.replace(/'/g, "''");
      await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `$p = New-Object System.Media.SoundPlayer '${literal}'; $p.PlaySync()`]);
    }
  } else {
    throw new Error(`Unsupported notification platform: ${platform}`);
  }
}
