# Windows / wmux notes

The main README's dance was validated on Kali Linux + tmux + `xdotool`. This
file is the Windows equivalent of the same mechanics, plus a few real,
Windows-specific findings not present on the Linux side. Read the main
README first — the underlying logic (LOCAL vs MANUAL callback URL, the
local-server redirect trick, why the printed URL is a trap) is identical;
only the tools driving the browser differ.

## Tool mapping

| Linux (README) | Windows equivalent |
|---|---|
| `xdotool search --class firefox` | `pywinauto`, `Desktop(backend="uia").windows()` filtered by title — **but see caveat below** |
| `xdotool windowactivate` | real mouse click on the window (see focus caveat below) — a bare `win.set_focus()` can silently fail under Windows' foreground-lock restriction; a real, coordinate-targeted click is exempt from that restriction and reliably works |
| `xdotool key ... ctrl+l / ctrl+v / Return` | prefer UIA's own patterns over simulated keys entirely — see below |
| NSS/keychain password decrypt | Firefox's own `nss3.dll` via `ctypes`: `os.add_dll_directory(firefox_dir)`, `NSS_Init(profile_path)`, `PK11SDR_Decrypt` on a `SECItem` struct wrapping the base64-decoded `logins.json` value. Never print/persist the decrypted value. |
| `aurora-screenshot` | `win.capture_as_image().save(path)` (pywinauto) |

## Prefer UIA value/invoke patterns over simulated input

Where the target element supports them, use these instead of simulated
keystrokes/clicks — they act directly through the accessibility API and
never touch the OS keyboard/mouse queue at all:

- **Setting a text field**: `edit_control.set_edit_text(value)` (UIA
  `ValuePattern.SetValue`). Verify with a readback
  (`edit_control.get_value()`) before relying on it.
- **Clicking a button**: `button.invoke()` (UIA `InvokePattern`). Verify
  the page actually changed — some web apps' buttons only listen for real
  pointer events and silently no-op on `.invoke()`. If unchanged, fall
  back to exactly one targeted `.click_input()` (a real, one-shot
  synthesized click) — never a retry loop.
- **Reading a link's real destination**: `hyperlink.legacy_properties()['Value']`
  gets the actual href directly — far more reliable than transcribing a
  long URL by eye from a screenshot.
- **Scrolling an off-screen element into view**: some elements expose
  `element.iface_scroll_item.ScrollIntoView()` even when the containing
  window doesn't support the Scroll pattern itself.

**Why this matters beyond convenience**: simulated `SendInput` keystrokes
go into the same OS-level input queue as a physically-present human's real
keyboard/mouse. Confirmed the hard way: automation keystrokes landed
directly inside a human's own live typing mid-sentence when both were
targeting the same machine concurrently. The value/invoke patterns above
have no such collision risk because they never touch that shared queue.

## Never use `send_keys`-style key-command-DSL typing for URLs/emails

`pywinauto`'s `send_keys()` (and similar libraries' equivalents)
interprets `+ % : @ &` as its own hotkey syntax, not literal characters.
Confirmed twice: an OAuth `scope` query parameter lost all its `+`/`%3A`
separators, and a bare `@` in an email address became `0`. If a
declarative `set_edit_text()` isn't available for some reason, use raw
`SendInput` with `KEYEVENTF_UNICODE`, one character at a time — never a
key-command-DSL typer for arbitrary text.

## The OS default browser may not be the browser you expect

`claude auth login`'s "opening browser" step launches the OS's actual
configured default browser — which may not be Firefox even if Firefox is
what you intend to drive. On one real run this was a DuckDuckGo app
instead. Confirm which real window opened via a raw `EnumWindows` scan by
window title (`user32.EnumWindows`) — `pywinauto`'s
`Desktop(backend="uia").windows()` can silently miss a window entirely if
that application has poor/absent UIA accessibility support. If a
browser-driving script isn't finding what it expects, verify which
process/window actually opened before assuming your own automation is
broken.

**If you accidentally end up in the wrong browser**: do not force-kill the
whole application to "clean up" — it may have other real, unrelated state
open. Close only the specific stray tab(s) you created, via that tab's own
UIA "Close tab" button (found as a child element of the `TabItem`
control), the same way you'd clean up in the intended browser.

## Further reading

- [`QUESTS-OF/claude-code-account-login`](https://github.com/QUESTS-OF/claude-code-account-login)
  — specific real runs, including an open, unresolved problem with the
  non-Google magic-link flow's single-use token behavior.
