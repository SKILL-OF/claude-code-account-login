# claude-code-account-login

Canonical agent procedure for switching the `claude` CLI account on a desktop machine with Firefox.

Validated on: aurora@aurora (Kali Linux, AMD Athlon 2850e, Firefox ESR, tmux). Took one full workday to derive. Do not improvise.

---

## The key fact that makes everything else follow

`claude auth login` generates **two OAuth URLs simultaneously**:

| URL | redirect_uri | Name |
|-----|-------------|------|
| LOCAL | `http://localhost:PORT/callback` | Automatic flow |
| MANUAL | `https://platform.claude.com/oauth/code/callback` | Manual fallback |

The CLI prints: `If the browser didn't open, visit: [MANUAL URL]`

**The printed URL is the MANUAL URL. Do not use it.** Using it and then trying to deliver the code to the local server creates a redirect_uri mismatch → HTTP 400.

Use the LOCAL URL instead. The browser follows the redirect to localhost automatically. No manual code delivery needed.

---

## Prerequisites

```bash
# 1. Check current auth state
claude auth status

# 2. Confirm Firefox is running
ps aux | grep firefox | grep -v grep

# 3. Confirm you have a plain shell pane (not a Claude Code session)
#    aurora:login-dance or any window showing `zsh`
```

---

## The dance (step by step)

### Step 1 — Start fresh in a plain shell window

```bash
# Open a new tmux window with a plain shell
tmux new-window -t aurora -n "login-dance"

# Verify it's a shell, not a claude session
tmux list-panes -t aurora:login-dance -F "#{pane_current_command}"
# Must show: zsh (not claude)
```

### Step 2 — Start login and capture the port

```bash
~/.local/bin/claude auth login --email YOUR@EMAIL 2>&1 | tee /tmp/auth-login.log
```

In a separate shell (your agent's Bash tool), immediately:

```bash
sleep 3
# Find the local server port
PORT=$(ss -tlnp | grep claude | grep -oP ':\K\d+' | head -1)
echo "PORT: $PORT"
```

### Step 3 — Reconstruct the LOCAL URL

The log file contains the MANUAL URL. Replace the redirect_uri:

```bash
MANUAL_URL=$(grep 'redirect_uri=https' /tmp/auth-login.log | grep -oP 'https://claude\.com[^\s]+')
LOCAL_URL="${MANUAL_URL/redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback/redirect_uri=http%3A%2F%2Flocalhost%3A${PORT}%2Fcallback}"
echo "$LOCAL_URL" | grep 'redirect_uri=http'   # verify substitution worked
```

### Step 4 — Navigate Firefox to the LOCAL URL

```bash
WID=$(xdotool search --class "firefox" 2>/dev/null | tail -1)
echo -n "$LOCAL_URL" | xclip -selection clipboard
xdotool windowactivate --sync $WID
sleep 0.5
xdotool key --window $WID ctrl+l
sleep 0.5
xdotool key --window $WID ctrl+v
sleep 0.3
xdotool key --window $WID Return
```

### Step 5 — Wait for the Authorize page, verify account

```bash
sleep 6 && aurora-screenshot /tmp/oauth-check.png
```

Confirm the page footer says **"Logged in as YOUR@EMAIL"**. If it shows the wrong account, click "Switch account" first, complete the magic link flow, then revisit the LOCAL URL.

### Step 6 — Click Authorize

```bash
WID=$(xdotool search --class "firefox" 2>/dev/null | tail -1)
xdotool windowactivate --sync $WID
sleep 0.5
# Authorize button is typically at center-x of the Firefox content area
# Adjust Y coordinate based on your screen geometry
GEOM=$(xdotool getwindowgeometry $WID | grep Geometry | grep -oP '\d+x\d+')
WIN_X=$(xdotool getwindowgeometry $WID | grep Position | grep -oP '^\s*\K\d+')
WIN_W=$(echo $GEOM | cut -dx -f1)
BTN_X=$((WIN_X + WIN_W / 2))
# Click approximate button area (adjust if needed)
xdotool mousemove $BTN_X 605 && xdotool click 1
```

After clicking, Firefox automatically follows the redirect to `http://localhost:PORT/callback`. The CLI receives the code with the matching redirect_uri and completes the token exchange.

### Step 7 — Verify

```bash
sleep 5
claude auth status
# Expect: "email": "YOUR@EMAIL", "loggedIn": true
```

---

## Why the manual flow fails (and what "manual flow" means)

The MANUAL URL uses `redirect_uri=https://platform.claude.com/oauth/code/callback`. After authorization, `platform.claude.com` shows an "Authentication code" page — it does NOT redirect to localhost. If you:

1. Copy the displayed code
2. Deliver it to `http://localhost:PORT/callback` via curl

...you get HTTP 400. The token exchange uses `redirect_uri=http://localhost:PORT/callback`, but the code was issued with the platform.claude.com redirect_uri. OAuth requires these to match.

The only correct delivery for a code obtained via the MANUAL URL is via stdin — but the CLI doesn't show a stdin prompt in current versions. The local callback flow is the correct path for desktop machines.

---

## If Firefox blocks the localhost redirect

Firefox ESR may block `https → http` mixed-content redirects. Check `about:config`:

```
security.mixed_content.block_active_content = false  (may be needed for localhost)
```

Or: set `network.security.ports.banned.override` to include your port.

If blocked, the browser stays at `platform.claude.com/oauth/code/callback`. You can then:
1. Capture the code and state from the URL bar: `code=XXXX&state=YYYY`
2. Manually call: `curl "http://[::1]:PORT/callback?code=XXXX&state=YYYY"`

This works ONLY if the port matches the one from the LOCAL URL (which was used in the OAuth request).

---

## If the wrong account is logged in on claude.ai

1. Click "Switch account" on the Authorize page → logs out the browser session
2. Enter YOUR@EMAIL on the login page → click "Continue with email"
3. **Arm `mail-watch.py` via Monitor BEFORE submitting the email** — magic link expires in ~5 min
4. Extract link: `python3 mail-watch.py` → get `href` matching `claude.ai/magic-link#...`
5. Paste link into Firefox address bar
6. Once logged in, navigate back to the LOCAL URL (the port must still be listening)
7. Authorize

---

## Pane safety — critical

- NEVER run `claude auth login` in a window showing a `❯` or Claude Code prompt
- Check with: `tmux list-panes -t TARGET -F "#{pane_current_command}"`
- Must show `zsh` before sending any shell commands

---

## Machine-specific notes (aurora@aurora)

- Firefox WID: `xdotool search --class "firefox" | tail -1` (multiple processes)
- Screenshot: `aurora-screenshot /tmp/out.png` (NOT `import` or `gnome-screenshot` — AVX2 → SIGILL)
- tmux: use `C-m` not `Enter`; use `xdotool windowactivate` not `windowfocus` to raise Firefox
- mail-watch.py: `python3 ~/_/AS/email-agent/mail-watch.py --timeout-minutes 5`
- The CLI's local server listens on `[::1]` (IPv6 localhost only) — use `http://[::1]:PORT/` or `http://localhost:PORT/`

---

## Time budget

On a slow machine (AMD Athlon 2850e), allow 5–8 minutes total:
- 3 min: page loads, Firefox automation
- ~2 min: magic link flow if account switch needed
- ~1 min: token exchange and verification

The magic link expires in 5 minutes. Move directly from "arm Monitor" → "submit email" → "paste link" without pausing.
