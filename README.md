# claude-code-account-login

Canonical agent procedure for switching the `claude` CLI account on a desktop machine, whether the
GUI-automation layer is Linux/xdotool or Windows/UI-Automation. The core OAuth fact (below) is
platform-independent; only the "drive the browser" mechanics differ per platform section.

Validated on:
- **aurora@aurora** (Kali Linux, AMD Athlon 2850e, Firefox ESR, tmux, xdotool). Took one full workday to derive. Do not improvise.
- **ottopoet-thesean@ottopoet-thesean** (Windows 11, Firefox, PowerShell + Windows UI Automation). See the Windows-specific section below — this machine uses Firefox, not Chrome, for account-login automation (Chrome triggers Cloudflare's bot-verification wall on a fresh/disposable profile; Firefox already carries a real, trusted session).

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

---

## Prerequisites

```bash
claude auth status                          # check current account
ps aux | grep firefox | grep -v grep        # confirm Firefox running
tmux list-panes -t TARGET -F "#{pane_current_command}"  # must show zsh, not claude
```

---

## The dance

### 1 — Open a plain shell window

```bash
tmux new-window -t aurora -n "login-dance"
# Verify: must show zsh
tmux list-panes -t aurora:login-dance -F "#{pane_current_command}"
```

### 2 — Start login and capture port

Send to the shell window (not via Claude Code Bash tool, which runs in a different session):

```bash
~/.local/bin/claude auth login --email YOUR@EMAIL 2>&1 | tee /tmp/auth-login.log
```

From your agent's Bash tool:

```bash
sleep 4
PORT=$(ss -tlnp | grep claude | grep -oP ':\K\d+' | head -1)
echo "PORT: $PORT"
```

### 3 — Reconstruct the LOCAL URL

```bash
MANUAL_URL=$(grep 'redirect_uri=https' /tmp/auth-login.log | grep -oP 'https://claude\.com[^\s]+')
LOCAL_URL="${MANUAL_URL/redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback/redirect_uri=http%3A%2F%2Flocalhost%3A${PORT}%2Fcallback}"
# Verify:
echo "$LOCAL_URL" | grep 'redirect_uri=http%3A%2F%2Flocalhost'
```

### 4 — Navigate Firefox to the LOCAL URL

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

### 5 — Confirm account and Authorize

The page footer must say **"Logged in as YOUR@EMAIL"**.

If wrong account: click "Switch account", complete magic link flow (arm `mail-watch.py` Monitor BEFORE submitting email), then revisit the LOCAL URL.

Click Authorize. Firefox redirects to `http://localhost:PORT/callback` automatically.

### 6 — Verify

```bash
sleep 5 && claude auth status
# Expect: "email": "YOUR@EMAIL", "loggedIn": true
```

---

## Why the MANUAL flow produces HTTP 400

When you use the MANUAL URL (`redirect_uri=platform.claude.com`) and then deliver the code to the local server:

- Code was issued with: `redirect_uri=https://platform.claude.com/oauth/code/callback`
- Token exchange sends: `redirect_uri=http://localhost:PORT/callback`
- OAuth server rejects: **redirect_uri mismatch → 400**

The reverse also fails: you cannot send a code obtained from the local callback through the manual token exchange path. Each URL must be used end-to-end.

---

## If Firefox blocks the localhost redirect

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

Note: the CLI's local server listens on `[::1]` (IPv6 localhost). Use `http://[::1]:PORT/` not `http://127.0.0.1:PORT/` if direct curl is needed.

---

## Magic link flow (if account switch required)

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

---

## Machine-specific notes (aurora@aurora)

| Concern | Fix |
|---------|-----|
| Screenshots | `aurora-screenshot /tmp/out.png` — NOT `import`/`gnome-screenshot` (AVX2 → SIGILL) |
| Firefox focus | `xdotool windowactivate` (raises window) not `windowfocus` (doesn't raise) |
| tmux send-keys | Use `C-m` not `Enter` |
| IPv6 socket | CLI server listens on `[::1]` — curl needs `http://[::1]:PORT/` or `http://localhost:PORT/` |
| Multiple Firefox WIDs | `xdotool search --class "firefox" \| tail -1` for the main window |

---

## Windows variant (PowerShell + UI Automation)

Same core OAuth fact applies (LOCAL url vs MANUAL url). The browser-driving mechanics
differ completely — and are more robust than the Linux/xdotool approach, because Windows
UI Automation reads the OS accessibility tree directly instead of guessing pixel
coordinates from a screenshot.

**Do not pixel-hunt from screenshots.** It looks tempting (screenshot → eyeball coordinate
→ click) but fails for real, repeatable reasons: DPI/monitor scaling, negative window
coordinates on secondary monitors, and image-viewer tools that silently display a resized
copy of the saved file (so eyeballed coordinates don't match the actual pixel grid). Use
UI Automation instead — it finds elements by name/role and returns real, absolute-screen
bounding rectangles.

### 1 — Find the real listening port

```powershell
# Start the login process (as its own foreground process, NOT inside your own interactive
# Claude Code pane — /login there is an unrecoverable interactive menu, see the warning below)
claude auth login --claudeai --email YOUR@EMAIL 2>&1 | Tee-Object -FilePath C:\temp\auth-login.log
```

```powershell
# From your agent's own shell, find the process and its actual listening port —
# don't assume; cross-reference the exact command line, since other processes may also
# be listening on unrelated ports.
$authProc = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like "*auth login*" }
$authProc.ProcessId
# then: netstat -ano | findstr LISTENING, cross-reference the PID that owns a 127.0.0.1 or [::1] port
```

### 2 — Reconstruct the LOCAL URL

Same string substitution as the Linux variant: swap only `redirect_uri` from
`https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback` to
`http%3A%2F%2Flocalhost%3A<PORT>%2Fcallback`. Keep `code_challenge`/`state` verbatim from
the same process's own printed output — a stale or mismatched value fails PKCE validation.

### 3 — Drive the browser via UI Automation, not xdotool/pixel-clicks

```powershell
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$proc = Get-Process -Id $firefoxPid   # or chrome, or any window
$root = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)

# Find an element by its accessible name — no coordinate guessing
$condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, "Authorize")
$element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)

# Prefer InvokePattern — works for most native controls and many web buttons
$pattern = $null
if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
} else {
    # Fallback: BoundingRectangle is already in ABSOLUTE SCREEN coordinates —
    # do NOT add the window's Left/Top offset (that's only needed for screenshot crops).
    $rect = $element.Current.BoundingRectangle
    $centerX = [int]($rect.X + $rect.Width / 2)
    $centerY = [int]($rect.Y + $rect.Height / 2)
    # Real OS-level click via user32.dll SetCursorPos + mouse_event (P/Invoke) —
    # indistinguishable from human input, works where InvokePattern is silently ignored
    # by a web app's raw-mouse-event click handler.
}
```

To list what's actually on a page (buttons, links, account tiles) without a screenshot at
all:

```powershell
$btnCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Button)
$root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCondition) |
    ForEach-Object { $_.Current.Name }
```

### 4 — Prefer an already-authenticated browser session over any credential entry

If the target account already has a cached Google/SSO session in the browser (check via
UI Automation for a `ListItem` control matching the account email, on the "Choose an
account" page), select that tile — this completes the whole flow with **zero password
entry, zero secrets in agent context**, matching the standing rule that a human types
passwords, never an agent. Only fall back to a magic-link/password flow (see the Linux
section above — the technique transfers directly) if no cached session exists.

### 5 — Verify

```powershell
Start-Sleep -Seconds 3
claude auth status
# Expect: "email": "YOUR@EMAIL", "loggedIn": true
```

### Machine-specific notes (ottopoet-thesean@ottopoet-thesean)

| Concern | Fix |
|---------|-----|
| Never queue `/login` into your own interactive Claude Code pane | It's a genuine multi-step interactive menu with no external watcher for your own pane — you can queue text into your own pane between turns, but nothing drives a live multi-step UI once queued. Run `claude auth login` as a separate foreground process instead. |
| Fresh/disposable browser profiles trigger Cloudflare Turnstile | Do not try to defeat it — that's a real anti-bot check, not a bug. Use a browser with genuine history (the human's own Firefox/Chrome), not a throwaway automation profile. |
| Chrome vs Firefox | This machine's Chrome had no cached session for the target account and a copied/disposable Chrome profile hit Cloudflare's wall; Firefox already had a real, trusted, logged-in session — use whichever browser the human actually uses day-to-day. |
| Window position math | `AutomationElement.BoundingRectangle` is absolute screen coordinates; a screenshot crop's coordinates are window-relative. Mixing the two conventions silently produces wrong click targets. |
| `InvokePattern.Invoke()` sometimes does nothing | Some web-app buttons bind click handlers to raw mouse events only. If invoking a pattern produces no visible state change, fall back to a real `mouse_event` click at the element's UIA-derived center. |

---

## Time budget

Allow 5–8 minutes total on a slow machine:
- 2 min: page loads, Firefox automation
- 2 min: magic link flow (if account switch needed)
- 1 min: token exchange and verification

The magic link expires in 5 minutes. Do not pause between "arm Monitor" → "submit email" → "paste link".
