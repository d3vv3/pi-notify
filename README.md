# pi-notify

Native desktop notifications for [Pi](https://pi.dev), with the exact bundled WAV sounds from [@mohak34/opencode-notifier](https://github.com/mohak34/opencode-notifier) v0.2.2, adapted to Pi's lifecycle. No model tools or prompt injection.

## Install

Requires Pi **1.2.0+** (`@earendil-works/pi-coding-agent`) and Node **22.22.2+, 24.15.0+, or 26+** within the supported release lines in `package.json`.

```sh
pi install npm:@d3vv3/pi-notify
```

Or install from a local checkout:

```sh
cd ~/projects/pi-notify
npm install
# Try for one session:
pi -e ./src/index.ts
# Or install persistently:
pi install ~/projects/pi-notify
```

Run `/reload` in an existing Pi session after installation or configuration changes. Avoid loading both the explicit file and the installed package simultaneously.

## Events and sounds

| Event | Default sound |
| --- | --- |
| Agent fully finished | `sounds/complete.wav` |
| Agent stopped with an error | `sounds/error.wav` |
| Blocking confirmation dialog | `sounds/permission.wav` |
| Blocking question/select/input/editor/custom dialog | `sounds/question.wav` |

The files are included in the package, not referenced from OpenCode's cache. `subagent_complete.wav` is also preserved from upstream but is not wired to an event: Pi has no generic child-completion event.

Completion uses `agent_settled`, not `agent_end`: intermediate retries and automatic continuations do not produce premature completion notifications. Aborted runs are silent. Recoverable tool failures are not treated as agent errors. UI prompts use `ui_prompt_start` only while an agent run is active, including dialogs from other extensions. Question tools named `ask_user_question` or `question` (including namespaced variants) also trigger alerts at `tool_call`, even if they do not open a Pi UI dialog. The optional `@gotgenes/pi-permission-system` integration listens to its public `permissions:ui_prompt` event; no dependency on that package is required. Tool/UI alerts are deduplicated while the corresponding request is active. Startup, `/reload`, and idle command dialogs are silent. Other custom question tools must open a Pi UI dialog to be detected.

Only interactive terminal (`tui`) sessions notify. Print, JSON, RPC and background child processes using those modes remain silent. This is not a parent/child session hierarchy filter: a separately launched interactive Pi session can notify independently.

Notifications show only the project directory name and generic event text, never prompts, tool arguments, or provider error details. The directory name can appear on your lock screen.

### Platform requirements

The same bundled audio plays on all three platforms; no extra sound download or OpenCode installation is needed.

- **macOS:** native Notification Center through `osascript`; bundled audio plays through `afplay`. Allow notifications for the script/terminal application when macOS asks. Focus settings may suppress banners; file audio plays separately from the notification service.
- **Linux:** install `notify-send` (commonly `libnotify-bin` or `libnotify`) and have a desktop notification service/session bus. Playback uses `paplay` (PulseAudio utilities; also works with PipeWire's PulseAudio compatibility service).
- **Windows:** native notifications through `node-notifier`/SnoreToast; bundled WAV files play through PowerShell's `System.Media.SoundPlayer` instead of the default Windows notification sound.

Notification delivery and audio on remote/SSH hosts are local to that host, not forwarded to your laptop.

On macOS, completion/error notifications are suppressed when the detected terminal application is frontmost. Questions and permission requests bypass focus suppression. Detection uses `TERM_PROGRAM`/`KITTY_PID`; set `terminal` for an unrecognized app. This checks the application, not a specific terminal window or tmux pane. Failure to query focus warns once and allows delivery. Click-to-focus, cmux routing, upstream title animations and timeout configuration are not implemented.

## Commands

```text
/notify                         Show status and config path
/notify off                     Mute for this session
/notify on                      Enable for this session
/notify test                    Test completion notification
/notify test error              Test error notification
/notify test permission         Test confirmation notification
/notify test question           Test question notification
```

Tests deliberately bypass mute, quiet hours and focus suppression; sound settings still apply. Delivery failures warn without failing or blocking the agent; event delivery runs asynchronously. Each external command is limited to five seconds. A notification or playback already submitted to the OS may finish after shutdown.

## Configuration

Optional file: `~/.pi/agent/pi-notify.json`. Override the path with `PI_NOTIFY_CONFIG`. Configuration loads on session start or `/reload`; commands change only in-memory settings.

```json
{
  "enabled": true,
  "suppressWhenFocused": true,
  "quietHours": {
    "enabled": false,
    "start": "22:00",
    "end": "08:00"
  }
}
```

Omit `sounds` to use the bundled defaults above. To customize, add e.g. `"sounds": { "idle": "/absolute/path/custom.wav", "error": false }`. Each sound accepts an **absolute path** (no `~` expansion), a macOS system sound name, or `false` for silence. Named sounds on Linux are silent; Windows named sounds select the standard system notification sound. If you explicitly override `permission` and omit `question`, the question sound inherits that override; otherwise it keeps its own bundled WAV. macOS files use `afplay`; Linux uses `paplay`; Windows requires WAV. Audio files longer than five seconds may be cut short by the command timeout.

Optional `"terminal": "Ghostty"` overrides macOS application detection. If you previously configured Glass/Basso/Submarine, remove those overrides to use the bundled sounds.

Quiet hours use local time, include the start, exclude the end, and support overnight windows. Equal start/end disables the window. Quiet hours also suppress questions. Invalid configuration produces a warning and disables automatic notifications instead of silently using defaults. Missing config uses defaults.

## Development

```sh
npm ci
npm run check
npm audit --omit=dev
npm pack --dry-run
```

Tests mock OS delivery and Pi lifecycle events; they do not pop up notifications. Run `/notify test` and the per-event variants in a real interactive Pi session to verify your desktop and sound permissions. macOS/Windows desktop integration requires testing on those platforms.

## Publishing

Releases follow the same version-on-`main` workflow as `opencode-ascii`: change `package.json` and `package-lock.json`, then push to `main`. `.github/workflows/release.yaml` runs checks, publishes with npm OIDC trusted publishing, and creates `v<version>` and a GitHub release only after publication succeeds. Source TypeScript is shipped directly for Pi; no build step is needed.

For the first publication, a maintainer must authenticate with npm (`npm login`) and run `npm publish --access public`. Then configure the package's npm **Trusted Publisher** with GitHub owner `d3vv3`, repository `pi-notify`, workflow filename `release.yaml`, and no environment. Later version bumps publish without an npm token. Do not enable the first automated release before that setup is complete.

## Credits and license

MIT. Bundled WAV files are copied unmodified from `@mohak34/opencode-notifier` v0.2.2 (Copyright © 2025 Mohak S); its distributed MIT notice is included at `sounds/LICENSE`. This records the license shipped with the source package, not an independent provenance audit of the recordings. Notification behavior was initially inspired by kdcokenny's [opencode-notify](https://github.com/kdcokenny/opencode-notify), which uses macOS system sound names instead. Not affiliated with the Pi or OpenCode teams.
