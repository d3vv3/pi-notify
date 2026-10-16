import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type Kind = "idle" | "error" | "permission" | "question";
export interface Config {
  enabled: boolean;
  suppressWhenFocused: boolean;
  terminal?: string;
  sounds: Record<Kind, string | false>;
  quietHours: { enabled: boolean; start: string; end: string };
}

export const bundledSounds: Record<Kind, string> = {
  idle: fileURLToPath(new URL("../sounds/complete.wav", import.meta.url)),
  error: fileURLToPath(new URL("../sounds/error.wav", import.meta.url)),
  permission: fileURLToPath(new URL("../sounds/permission.wav", import.meta.url)),
  question: fileURLToPath(new URL("../sounds/question.wav", import.meta.url)),
};

export function parseConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  const v = value as Record<string, unknown>;
  const config: Config = {
    enabled: true,
    suppressWhenFocused: true,
    sounds: { ...bundledSounds },
    quietHours: { enabled: false, start: "22:00", end: "08:00" },
  };
  for (const key of ["enabled", "suppressWhenFocused"] as const) {
    if (v[key] !== undefined) {
      if (typeof v[key] !== "boolean") throw new Error(`${key} must be boolean`);
      config[key] = v[key];
    }
  }
  if (v.terminal !== undefined) {
    if (typeof v.terminal !== "string" || !v.terminal.trim()) throw new Error("terminal must be a nonempty macOS app name");
    config.terminal = v.terminal;
  }
  if (v.sounds !== undefined) {
    if (!v.sounds || typeof v.sounds !== "object" || Array.isArray(v.sounds)) throw new Error("sounds must be an object");
    const sounds = v.sounds as Record<string, unknown>;
    for (const kind of Object.keys(config.sounds) as Kind[]) {
      const sound = sounds[kind];
      if (sound !== undefined) {
        if (sound !== false && (typeof sound !== "string" || !sound.trim())) throw new Error(`sounds.${kind} must be a sound name, absolute file path, or false`);
        config.sounds[kind] = sound;
      }
    }
    if (sounds.question === undefined && sounds.permission !== undefined) config.sounds.question = config.sounds.permission;
  }
  if (v.quietHours !== undefined) {
    if (!v.quietHours || typeof v.quietHours !== "object" || Array.isArray(v.quietHours)) throw new Error("quietHours must be an object");
    const q = v.quietHours as Record<string, unknown>;
    if (q.enabled !== undefined) {
      if (typeof q.enabled !== "boolean") throw new Error("quietHours.enabled must be boolean");
      config.quietHours.enabled = q.enabled;
    }
    for (const key of ["start", "end"] as const) {
      if (q[key] !== undefined) {
        if (typeof q[key] !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(q[key])) throw new Error(`quietHours.${key} must be HH:MM`);
        config.quietHours[key] = q[key];
      }
    }
  }
  return config;
}

export function configPath(): string {
  return process.env.PI_NOTIFY_CONFIG || join(homedir(), ".pi", "agent", "pi-notify.json");
}

export async function loadConfig(path = configPath()): Promise<Config> {
  try {
    return parseConfig(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return parseConfig({});
    throw error;
  }
}

export function isQuiet(config: Config, now = new Date()): boolean {
  if (!config.quietHours.enabled) return false;
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
  const start = minutes(config.quietHours.start);
  const end = minutes(config.quietHours.end);
  const current = now.getHours() * 60 + now.getMinutes();
  return start > end ? current >= start || current < end : current >= start && current < end;
}
