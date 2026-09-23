# Login Dance Flowchart

Decision logic for account switching. This is the *when* and *which branch* view.
The state machines in README.md are the *what happens in each state* view.
They must stay in sync — a new divergence documented here needs a corresponding state in the README.

---

## Full Decision Tree

```mermaid
flowchart TD
    Start([Quota warning triggered]) --> Triage{5h > 80%\nor 7d > 97%?}
    Triage -- No --> Monitor[Collect sample\ncontinue monitoring]
    Triage -- Yes --> Score[Score all 4 accounts\nby headroom]

    Score --> BetterExists{Any account with\nbetter headroom?}
    BetterExists -- No --> Exhausted[⚠️ All accounts near-exhausted\nNotify Victor — no dance possible]
    BetterExists -- Yes --> Select[Select target account\nMax: min headroom-5h, headroom-7d\nTiebreak: lowest 7d usage]

    Select --> GuardianReady{Guardian agent\navailable?}
    GuardianReady -- No --> NoGuardian[⛔ Cannot dance alone\nTUI will lock for OAuth duration\nRecruit guardian before starting]
    GuardianReady -- Yes --> FlowBranch{Gmail or\nnon-Gmail?}

    FlowBranch -- Non-Gmail\nFlow A --> FA_Start[Shell:\nclaude auth login\n--email ACCOUNT]
    FlowBranch -- Gmail\nFlow B --> FB_Start[Shell:\nclaude auth login\n--email GMAIL_ACCOUNT]

    FA_Start --> TUILocked_A[⚠️ TUI LOCKED\nGuardian monitors via\nwmux terminal_read or tmux log]
    TUILocked_A --> FA_URLCapture[Guardian extracts LOCAL URL\nfrom log output\nDO NOT use the printed MANUAL URL]

    FB_Start --> TUILocked_B[⚠️ TUI LOCKED\nGuardian monitors log]
    TUILocked_B --> FB_URLCapture[Guardian captures\nGoogle OAuth URL from log]

    FA_URLCapture --> FA_Open[Guardian opens LOCAL URL\nin browser]
    FB_URLCapture --> FB_Open[Guardian opens Google\nOAuth URL in browser]

    FA_Open --> FA_BrowserBranch{Same browser\nfollows redirect\nautomatically?}
    FA_BrowserBranch -- Yes, redirected --> OAuthPage
    FA_BrowserBranch -- No, different browser\nintercepted --> SixDigit_A[6-digit code shown\nin different browser]
    SixDigit_A --> Deliver6_A[Guardian reads code\ndelivers to locked TUI\nvia terminal_send]
    Deliver6_A --> OAuthPage

    FB_Open --> FB_GoogleStep{Google account\npicker shown?}
    FB_GoogleStep -- Already signed in\nas correct account --> GoogleAuth
    FB_GoogleStep -- Account picker shown --> FB_Pick[Select correct Gmail account]
    FB_Pick --> GoogleAuth[Google Authorize screen]
    GoogleAuth --> FB_Allow[Click Allow / Continue]
    FB_Allow --> CallbackCheck

    OAuthPage{OAuthPage:\nCorrect account\nin footer?}
    OAuthPage -- Yes --> Authorize[Click Authorize]
    OAuthPage -- No, wrong account --> SwitchAccount[Click Switch account]

    SwitchAccount --> ArmMonitor[Arm magic link monitor\nBEFORE submitting email\n5-min expiry — move fast]
    ArmMonitor --> SubmitEmail[Submit email address]
    SubmitEmail --> MagicLinkBranch{Magic link opened by\nwhich browser?}
    MagicLinkBranch -- Same browser\npage reloads --> OAuthPage
    MagicLinkBranch -- Different browser\n6-digit code shown --> SixDigit_ML[Read 6-digit code]
    SixDigit_ML --> Deliver6_ML[Deliver code to TUI\nvia terminal_send]
    Deliver6_ML --> OAuthPage

    Authorize --> CallbackCheck{localhost callback\nredirect succeeds?}
    CallbackCheck -- Yes → browser\nlands on localhost --> TUIUnlocked
    CallbackCheck -- No → browser blocked\nat platform.claude.com --> ExtractCode[Guardian reads\ncode + state from URL bar]
    ExtractCode --> CurlDelivery[curl http://:::1:PORT/callback\n?code=CODE&state=STATE\nNote: IPv6 bracket syntax]
    CurlDelivery --> TUIUnlocked

    TUIUnlocked --> Verify[claude auth status\nconfirm loggedIn:true\nconfirm correct email]
    Verify --> RCRefresh[/remote-control refresh\nin every affected pane\nAll agents need new visibility]
    RCRefresh --> Done([Dance complete\nLog switch event\nto quota-timeseries.jsonl])
```

---

## Phase Space Map: Divergence Points

| Divergence | Where it appears | What happens |
|---|---|---|
| **DiffBrowser6Digit** | Flow A — after guardian opens LOCAL URL | A second browser (different app/profile) intercepts the link. Shows 6-digit code. Must be delivered to locked TUI. |
| **WrongAccount** | OAuth page — footer shows wrong email | Click "Switch account", arm monitor, submit email, wait for magic link. |
| **MagicLinkDiffBrowser** | Flow A after magic link email | Magic link opened by wrong browser → shows 6-digit code (not a redirect). |
| **CallbackBlocked** | Both flows — after Authorize clicked | Browser cannot redirect `https → http`. Auth code visible in URL bar. Use curl to deliver it to the local server directly. |
| **GoogleAlreadySignedIn** | Flow B — Google OAuth URL opened | No account picker shown — goes straight to Authorize screen. Safe to proceed. |
| **AllAccountsExhausted** | Triage — before selecting target | All 4 accounts near limit. No dance helps. Must wait for a reset. |

---

## Key Facts (Prevent Known Failures)

1. **LOCAL URL vs MANUAL URL** — The CLI prints the MANUAL URL. Never use it. Reconstruct the LOCAL URL from the log (replace `redirect_uri=https%3A%2F%2F...` with `http://localhost:PORT`). See README for exact substitution.

2. **TUI lock is total** — The dancing agent's harness tools (ListAgents, SendMessage, terminal_read) do not work during the OAuth wait. Guardian must use wmux meta-harness.

3. **browser_open always creates a new pane** — `pane_focus` via API does not influence where the browser window splits. After `browser_open`, verify the new pane and label it. (wmux constraint; confirmed 2026-09-23 across three agent attempts.)

4. **Callback server listens on IPv6** — `http://[::1]:PORT/` not `http://127.0.0.1:PORT/` for the curl fallback.

5. **Magic link expires in 5 minutes** — Arm the monitor FIRST, submit email SECOND, paste link THIRD. No pauses.

6. **Two distinct 6-digit code scenarios** — `DiffBrowser6Digit` (different browser intercepts OAuth URL mid-dance) vs `MagicLink6Digit` (magic link opened by different browser) are different states. Both require guardian to deliver code to locked TUI.

7. **Final OAuth code ≠ 6-digit code** — `CallbackBlocked` state shows the final auth code + state in the URL bar. This is not a 6-digit code; it's a full `code=...&state=...` URL parameter string for curl delivery.

---

## Quota Trigger Thresholds (when to initiate)

| Condition | Urgency |
|---|---|
| 5h > 80% AND burn rate > 10%/hr | Start preparing, notify Victor |
| 5h > 90% | Urgent — initiate now |
| 7d > 97% | Emergency — only account switch or reset saves the session |
| Projected depletion < dance time (5–8 min) | Too late — already in trouble |

Dance cost: 5–8 minutes elapsed, ~0.5% 5hr token burn for the dance itself.

---

## Account Rotation Order

```
dariensirius@protonmail.com (A) → claude.anthropic@aurora.wordgarden.dev (B) → ottopoet.thesean@gmail.com (C) → A
```

A and B: Flow A (non-Gmail). C: Flow B (Gmail).
With ~3hr active cycles, A's 5hr quota resets by the time you rotate back.

---

## Guardian Checklist

Before starting the dance, confirm guardian can:
- [ ] Read the dancing agent's terminal output (`terminal_read` / tmux log)
- [ ] Send text to the dancing agent's terminal (`terminal_send` / tmux send-keys)
- [ ] Open a browser (`browser_open`) or otherwise navigate to URLs
- [ ] Read the browser contents (URL bar, page text) to extract codes
- [ ] Deliver content to the locked TUI (codes, curl commands)

---

*Last updated: 2026-09-23 by hazrat-rabbit (Instance 16) — added flowchart, phase space map, wmux observations.*
*Coordinate with w14-1 (Meridian) for Windows/wmux appendix.*
