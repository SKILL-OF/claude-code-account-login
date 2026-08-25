# claude-code-account-login

Canonical agent procedure for switching the `claude` CLI account. The OAuth
mechanism below is environment-agnostic; the browser-automation steps are not
and are organized per implementation. Two implementations are validated so
far — pick the one matching your OS/browser, or use them as a template for a
third. **Do not improvise the automation steps for an environment neither one
covers** — derive and validate a new implementation section instead, the way
both of these were.

---

## The key fact that makes everything else follow

`claude auth login` generates **two OAuth URLs simultaneously**:

| URL | redirect_uri | Name |
|-----|-------------|------|
| LOCAL | `http://localhost:PORT/callback` | Automatic flow |
| MANUAL | `https://platform.claude.com/oauth/code/callback` | Manual fallback |

The CLI prints: `If the browser didn't open, visit: [MANUAL URL]`

**The printed URL is the MANUAL URL. Do not use it.** Using it and then trying to deliver the code to the local server creates a redirect_uri mismatch → HTTP 400.

Use the LOCAL URL. The browser follows the redirect to localhost automatically. No manual code delivery needed.

## Why the MANUAL flow produces HTTP 400

When you use the MANUAL URL (`redirect_uri=platform.claude.com`) and then deliver the code to the local server:

- Code was issued with: `redirect_uri=https://platform.claude.com/oauth/code/callback`
- Token exchange sends: `redirect_uri=http://localhost:PORT/callback`
- OAuth server rejects: **redirect_uri mismatch → 400**

The reverse also fails: you cannot send a code obtained from the local callback through the manual token exchange path. Each URL must be used end-to-end.

## Run login from a separate shell, not your own agent Bash tool

Whichever OS you're on: invoke `claude auth login` from a plain shell window
or a genuinely separate pane/session — never from the same Bash tool call an
agent is using to drive its own current Claude Code session. Two independent
reasons, both real:

1. The command opens an interactive OAuth wait; running it inline blocks
   that tool call until the browser flow completes, with no way to drive
   the browser from the same turn.
2. **Login credentials are typically stored per-OS-user, not per-window or
   per-session.** Completing a *new* login anywhere on the machine can
   overwrite the exact credentials an already-running agent session is
   using for its own API auth — including, if you're not careful, the very
   session orchestrating this switch. Do the login in a disposable
   pane/window, verify the switch with `claude auth status` there first,
   and only then treat it as safe.

## The account-confirmation gate (applies to every implementation)

Whatever automation drives the browser, the OAuth authorize page always
shows **"Logged in as `<email>`"** with a **"Switch account"** link before
its **Authorize** button. Read that line before clicking Authorize — it's
the one universal checkpoint that catches a wrong-account session
regardless of how you got the page on screen.

---

## Implementation: Linux + Firefox + tmux + xdotool

Validated on: aurora@aurora (Kali Linux, AMD Athlon 2850e, Firefox ESR, tmux). Took one full workday to derive.

### Prerequisites

```bash
claude auth status                          # check current account
ps aux | grep firefox | grep -v grep        # confirm Firefox running
tmux list-panes -t TARGET -F "#{pane_current_command}"  # must show zsh, not claude
```

### The dance

**1 — Open a plain shell window**

```bash
tmux new-window -t aurora -n "login-dance"
# Verify: must show zsh
tmux list-panes -t aurora:login-dance -F "#{pane_current_command}"
```

**2 — Start login and capture port**

Send to the shell window (not via Claude Code Bash tool — see "Run login from a separate shell" above):

```bash
~/.local/bin/claude auth login --email YOUR@EMAIL 2>&1 | tee /tmp/auth-login.log
```

From your agent's Bash tool:

```bash
sleep 4
PORT=$(ss -tlnp | grep claude | grep -oP ':\K\d+' | head -1)
echo "PORT: $PORT"
```

**3 — Reconstruct the LOCAL URL**

```bash
MANUAL_URL=$(grep 'redirect_uri=https' /tmp/auth-login.log | grep -oP 'https://claude\.com[^\s]+')
LOCAL_URL="${MANUAL_URL/redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback/redirect_uri=http%3A%2F%2Flocalhost%3A${PORT}%2Fcallback}"
# Verify:
echo "$LOCAL_URL" | grep 'redirect_uri=http%3A%2F%2Flocalhost'
```

**4 — Navigate Firefox to the LOCAL URL**

```bash
WID=$(xdotool search --class "firefox" 2>/dev/null | tail -1)
echo -n "$LOCAL_URL" | xclip -selection clipboard
xdotool windowactivate --sync $WID && sleep 0.5
xdotool key --window $WID ctrl+l && sleep 0.5
xdotool key --window $WID ctrl+v && sleep 0.3
xdotool key --window $WID Return
sleep 6
aurora-screenshot /tmp/oauth-check.png
```

**5 — Confirm account and Authorize**

Per "The account-confirmation gate" above. If wrong account: click "Switch account", complete magic link flow (arm `mail-watch.py` Monitor BEFORE submitting email), then revisit the LOCAL URL.

Click Authorize. Firefox redirects to `http://localhost:PORT/callback` automatically.

**6 — Verify**

```bash
sleep 5 && claude auth status
# Expect: "email": "YOUR@EMAIL", "loggedIn": true
```

### If Firefox blocks the localhost redirect

Firefox may block `https → http` mixed-content redirects. Symptoms: browser stays at `platform.claude.com/oauth/code/callback` showing an "Authentication code" page.

Fix: capture the code from the URL bar at that page, then call the local server directly:

```bash
# URL bar shows: https://platform.claude.com/oauth/code/callback?code=XXXX&state=YYYY
CODE="XXXX"
STATE="YYYY"
curl "http://[::1]:${PORT}/callback?code=${CODE}&state=${STATE}"
# Expect: 302 Found (then auth completes)
```

This works because the LOCAL URL was used in the OAuth request — the redirect_uri is consistent.

Note: the CLI's local server listens on `[::1]` (IPv6 localhost) on Linux. Use `http://[::1]:PORT/` not `http://127.0.0.1:PORT/` if direct curl is needed.

### Magic link flow (if account switch required)

```bash
# 1. Arm monitor BEFORE submitting email
# (via Claude Code Monitor tool on mail-watch.py)

# 2. Submit email on login page in Firefox

# 3. When Monitor fires with email JSON:
python3 ~/_/AS/email-agent/mail-watch.py --timeout-minutes 5 2>/dev/null

# 4. Extract magic link from email
python3 - << 'EOF'
import imaplib, ssl, subprocess, email, re
from pathlib import Path
HOST, PORT_IMAP, USER = 'mail.wordgarden.dev', 993, 'aurora@wordgarden.dev'
SCRIPT = Path('/home/aurora/_/AS/email-agent/_nss_decrypt.py')
pw = subprocess.check_output(['python3', str(SCRIPT)], text=True).strip()
ctx = ssl.create_default_context()
with imaplib.IMAP4_SSL(HOST, PORT_IMAP, ssl_context=ctx) as M:
    M.login(USER, pw)
    M.select('INBOX')
    # Use UID from monitor event
    typ, data = M.fetch('UID_HERE', '(RFC822)')
    msg = email.message_from_bytes(data[0][1])
    for part in msg.walk():
        body = part.get_payload(decode=True)
        if body:
            links = re.findall(r'https://[^\s"<>]*magic-link[^\s"<>]*', body.decode('utf-8', errors='replace'))
            if links: print(links[0]); break
EOF

# 5. Paste magic link into Firefox (clipboard, then ctrl+l ctrl+v Enter)
# 6. After login: revisit LOCAL URL, verify account, click Authorize
```

Magic links are single-use and expire in ~5 minutes. Move fast.

### Machine-specific notes (aurora@aurora)

| Concern | Fix |
|---------|-----|
| Screenshots | `aurora-screenshot /tmp/out.png` — NOT `import`/`gnome-screenshot` (AVX2 → SIGILL) |
| Firefox focus | `xdotool windowactivate` (raises window) not `windowfocus` (doesn't raise) |
| tmux send-keys | Use `C-m` not `Enter` |
| IPv6 socket | CLI server listens on `[::1]` — curl needs `http://[::1]:PORT/` or `http://localhost:PORT/` |
| Multiple Firefox WIDs | `xdotool search --class "firefox" \| tail -1` for the main window |

### Time budget

Allow 5–8 minutes total on a slow machine:
- 2 min: page loads, Firefox automation
- 2 min: magic link flow (if account switch needed)
- 1 min: token exchange and verification

The magic link expires in 5 minutes. Do not pause between "arm Monitor" → "submit email" → "paste link".

---

## Implementation: Windows + Firefox + PowerShell UI Automation

Validated on: ottopoet-thesean (Windows 11, Firefox as default browser, wmux
harness). ~15 minutes end-to-end including diagnosing a real intermittent
side effect. `xdotool` has no Windows equivalent; this implementation uses
`System.Windows.Automation` (UI Automation) instead, which is not just a
port of the Linux approach but a more robust mechanism in its own right —
it finds and invokes elements by accessible name, never by screen
coordinate, so it doesn't depend on window position, size, or resolution
at all.

### Prerequisites

```powershell
claude auth status   # check current account, from PowerShell
Get-Process firefox -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -ne "" }
```

### Known issue: raw coordinate clicks can minimize every window

**Do not drive the browser with `SetCursorPos` + `mouse_event` coordinate
clicks.** In this validation, two independent attempts at the identical,
correctly-computed screen coordinate for a real on-screen link both
resulted in every open window minimizing instead of the click landing —
reproducible, not a fluke. Root cause wasn't fully isolated (a screen
reader running in the session, or some other global input hook, is the
leading suspect), but the fix is simple: **use UI Automation's
`InvokePattern` to invoke elements by name instead of simulating a mouse
click at all.** This had zero side effects across the entire rest of the
procedure. If a future implementation on a clean Windows machine finds
coordinate-clicking safe there, note the environment difference rather
than assuming this issue is universal — it's recorded as observed, not
explained.

### The dance

**1 — Start login from a separate pane**

Per "Run login from a separate shell" above — a fresh wmux pane, not the
agent's own Bash tool call.

```powershell
claude auth login 2>&1 | Tee-Object -FilePath "$env:TEMP\auth-login.log"
```

Windows opens the printed MANUAL URL in the system default browser
automatically — no manual copy/paste needed to get *a* browser window
open, though per the OAuth mechanism above, that URL itself is not the
one to authorize on.

**2 — Capture the local callback port**

`ss` doesn't exist on Windows; match the listening port to the actual
`claude.exe auth login` process, not just by process name (multiple
node/claude processes can be listening at once):

```powershell
$conns = Get-NetTCPConnection -State Listen
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p.ProcessName -eq 'claude') { Write-Host "Port: $($c.LocalPort), PID: $($p.Id)" }
}
```

Cross-check against the specific PID from step 1's process, not just any
process named `claude`.

**3 — Reconstruct the LOCAL URL**

Same string-substitution logic as the Linux implementation — swap
`redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback`
for `redirect_uri=http%3A%2F%2Flocalhost%3A<PORT>%2Fcallback` in the
MANUAL URL printed to the login log.

**4 — Bring the real browser window to the foreground reliably**

A plain `SetForegroundWindow` call can lose to another application
re-raising itself (observed: a peer agent process kept re-raising its own
window). Use `AttachThreadInput` to make the foreground switch stick:

```powershell
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class Win32 {
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
}
'@
$ff = Get-Process firefox | Where-Object { $_.MainWindowTitle -ne "" } | Select-Object -First 1
$fgWin = [Win32]::GetForegroundWindow()
$fgThread = 0
[Win32]::GetWindowThreadProcessId($fgWin, [ref]$fgThread) | Out-Null
$curThread = [Win32]::GetCurrentThreadId()
[Win32]::AttachThreadInput($curThread, $fgThread, $true) | Out-Null
[Win32]::ShowWindow($ff.MainWindowHandle, 9) | Out-Null   # SW_RESTORE
[Win32]::BringWindowToTop($ff.MainWindowHandle) | Out-Null
[Win32]::SetForegroundWindow($ff.MainWindowHandle) | Out-Null
[Win32]::AttachThreadInput($curThread, $fgThread, $false) | Out-Null
# Verify it actually stuck:
Write-Host (($ff.MainWindowHandle -eq [Win32]::GetForegroundWindow()))
```

Verify the boolean is `True` before proceeding — don't assume the call
succeeded just because it didn't throw.

**5 — Navigate and confirm the account, via UI Automation, not clicks**

```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ff.Id)
$ffWindow = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

# Find any element by its accessible name -- works for links, buttons, edit fields alike
function Find-ByName($window, $name) {
  $nameCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  return $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $nameCond)
}

# Navigate the OS-opened browser tab to the LOCAL url (address bar is a ComboBox)
$addressBar = $ffWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ComboBox)))
$addressBar.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($LOCAL_URL)

# SetValue alone doesn't submit the navigation -- send a real Enter keystroke.
# keybd_event, not mouse simulation, is what stayed safe throughout this
# validation (see "Known issue" above).
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class KeySim {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);
}
'@
[KeySim]::keybd_event(0x0D, 0, 0, 0)  # VK_RETURN down
[KeySim]::keybd_event(0x0D, 0, 2, 0)  # VK_RETURN up (KEYEVENTF_KEYUP)
Start-Sleep -Milliseconds 2000
# Read the confirmation line as real text before clicking anything, per "account-confirmation gate" above:
$loggedInAs = Find-ByName $ffWindow "*"  # inspect descendants for "Logged in as <email>" text -- match by substring, not exact name
```

**6 — Authorize, once the account line is confirmed correct**

```powershell
$authorizeBtn = Find-ByName $ffWindow "Authorize"
$authorizeBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
```

**7 — If the wrong account is shown: switch, via the same saved-login reuse pattern**

No IMAP/Python script is needed on Windows if the real desktop browser
already has an authenticated session for the target account (e.g. Gmail) —
check before building anything more complex:

```powershell
# Click "Switch account" (a Hyperlink, found by exact name)
(Find-ByName $ffWindow "Switch account").GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
# Type the target email into the Edit field
$emailField = $ffWindow.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)))
$emailField.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($TARGET_EMAIL)
(Find-ByName $ffWindow "Continue with email").GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

# Open a new tab (Ctrl+T works fine via keybd_event -- only mouse clicks showed the minimize issue),
# navigate to mail.google.com, and check whether the account is ALREADY logged in there
# (a real desktop browser's saved session, not a fresh automation profile, often already is).
# Find the actual verification email by partial name match:
$emailLink = $ffWindow.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
  Where-Object { $_.Current.Name -like "*secure link to Claude.ai*" -and $_.Current.ControlType.ProgrammaticName -like "*Hyperlink*" }
$emailLink.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()

# Inside the opened email, invoke the "Sign in" hyperlink the same way.
# IMPORTANT: this signs the BROWSER into the general web app (claude.ai/new),
# it does NOT complete the original CLI OAuth authorize flow -- that tab's
# own URL gets replaced by the "waiting for verification" page the moment
# "Continue with email" is clicked. After the magic link completes the
# general web login, re-navigate that SAME original tab back to the
# reconstructed LOCAL URL from step 3 -- it will now show "Logged in as
# <target email>", and Authorize proceeds normally from there.
```

**8 — Verify**

Back in the separate pane from step 1:

```powershell
claude auth status
# Expect: "email": "<target>@...", "loggedIn": true
```

Also confirm the shared credential store actually updated (this is what
every other Claude Code session on the machine reads):

```powershell
node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.USERPROFILE+'/.claude.json','utf8')).oauthAccount.emailAddress)"
```

### Machine-specific notes (ottopoet-thesean)

| Concern | Fix |
|---------|-----|
| Screenshots | `System.Drawing.Graphics.CopyFromScreen` + `System.Windows.Forms.SystemInformation.VirtualScreen`, saved to a temp PNG and read back — no dedicated screenshot utility needed |
| Element interaction | UI Automation `InvokePattern`/`ValuePattern` by accessible name — never raw coordinate clicks (see "Known issue" above) |
| Window foreground | `AttachThreadInput` + `SetForegroundWindow` + `BringWindowToTop`, verified by comparing `GetForegroundWindow()` after the call, not assumed |
| New tab / address bar | `keybd_event` for Ctrl+T and Ctrl+L are safe; only mouse-click simulation showed the minimize side effect |
| Local callback port | Match `Get-NetTCPConnection -State Listen` against the specific `claude.exe auth login` PID via `Get-CimInstance`/`Get-Process`, not just a name grep |
| Credential scope | `~/.claude.json`'s `oauthAccount` and `~/.claude/.credentials.json` are per-Windows-user, shared across every open Claude Code session/pane — see "Run login from a separate shell" above |

### Time budget

~15 minutes including diagnosing the coordinate-click issue from scratch;
expect ~5 minutes once the UI Automation approach is used directly and
the issue isn't rediscovered each time.
