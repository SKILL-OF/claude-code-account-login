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

## Time budget

Allow 5–8 minutes total on a slow machine:
- 2 min: page loads, Firefox automation
- 2 min: magic link flow (if account switch needed)
- 1 min: token exchange and verification

The magic link expires in 5 minutes. Do not pause between "arm Monitor" → "submit email" → "paste link".
