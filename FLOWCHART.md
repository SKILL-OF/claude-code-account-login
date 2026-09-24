# Login Dance Flowchart

Decision logic for account switching. This is the *when* and *which branch* view.
The state machines in README.md are the *what happens in each state* view.
They must stay in sync — a new divergence documented here needs a corresponding state in the README.

---

## Entry Points: Two Distinct Graphs

These are NOT the same entry point. They live in different contexts and are interpreted by different systems.

| Entry | Where it runs | Who interprets it |
|---|---|---|
| `/login` (slash command) | Claude Code chat input box (TUI) | Claude Code harness |
| `claude auth login --email ACCOUNT` | Shell (PowerShell/bash) | Operating system + claude CLI |

**`/login` cannot be run in a shell.** `/login` at a PowerShell/bash prompt = `C:\login` (filesystem path). **`claude auth login` cannot be run in a Claude Code chat box.** It is a shell command, not a slash command.

The two entry paths may converge at common nodes (OAuthPage, CallbackCheck, etc.) but they START in different contexts.

---

## Entry A: `/login` slash command (in a running Claude Code session)

```mermaid
flowchart TD
    EntryA([/login slash command\nin Claude Code chat input]) --> AlreadyAuth{Session already\nauthenticated?}
    AlreadyAuth -- Yes --> LoginConfirmed[Login successful\nfast path — no TUI lock\nno browser\nno OAuth]
    AlreadyAuth -- No --> MethodMenu[3-way method\nselection menu shown\nEsc to cancel at any depth]

    MethodMenu -- 1. Claude account\nPro/Max/Team/Enterprise --> TUILocked_1[TUI LOCKED\n✽ Opening browser to sign in…\nCLI attempts OS-level browser launch\nMANUAL OAuth URL generated]
    MethodMenu -- 2. Console/API --> ConsoleSubmenu[3-item submenu:\nsign in / create legacy API key / go back]
    MethodMenu -- 3. 3rd-party\nBedrock/Foundry/Vertex --> ThirdPartySubmenu[4-item submenu:\nBedrock interactive / Foundry docs-only /\nVertex AI interactive / go back]
    MethodMenu -- Esc --> LoginInterrupted[Login interrupted\nnormal chat resumes]

    ConsoleSubmenu -- go back --> MethodMenu
    ThirdPartySubmenu -- go back --> MethodMenu

    TUILocked_1 --> CLIBrowserAttempt{OS browser tab\nactually opened?}
    CLIBrowserAttempt -- Yes → OS tab opened\nin default browser --> TabPresent[OS tab open in default browser\nCLI used LOCAL URL variant\nredirect_uri=http://localhost:PORT\nUIA can read+interact with this tab]
    CLIBrowserAttempt -- No → tab blocked\nor no browser --> ManualURL[TUI shows MANUAL URL\n'Browser didn't open? Use URL below'\n'Paste code here if prompted >'\nguardian must open manually]

    TabPresent --> UIASample[Guardian: UIA reads default browser window\nSystem.Windows.Automation PowerShell\nno CDP/debug port needed\nreads address bar + page content + buttons]
    UIASample --> BrowserAccountCheck{BrowserAccountCheck:\nUIA reads page footer / account indicator\nWhich account is this browser currently logged in as?}
    BrowserAccountCheck -- Browser logged in as TARGET account\n→ Authorize screen → CORRECT low-cost path --> UIAAuthorize[⭐ LOW COST path:\nWin32 coordinate click: SetForegroundWindow first\nthen SetCursorPos + mouse_event at BoundingRectangle center\nInvokePattern FAILS on Chromium/CEF — false positive\nno human step needed]
    BrowserAccountCheck -- Browser logged in as CURRENT (old) account\n→ Authorize screen → LOOPBACK TRAP --> LoopbackTrap[⚠️ LOOPBACK TRAP:\nBrowser is logged in as the account you are switching FROM\nAuthorizing here re-authenticates the old account\nMust switch browser identity before Authorize]
    BrowserAccountCheck -- No session → Login page shown --> HumanLogin[⛔ HIGH COST path:\nhuman must log in manually\nmaximum weight — avoid if possible]
    LoopbackTrap --> SwitchBrowserAccount[Switch browser account:\nsign out → sign in as TARGET\nor use account switcher if present]
    SwitchBrowserAccount --> BrowserAccountCheck
    HumanLogin --> UIAAuthorize

    UIAAuthorize --> LocalCallbackCheck{localhost:PORT/callback\nreceived by TUI local server?}
    LocalCallbackCheck -- Yes → auto redirect --> TUIUnlocked_A[TUI completes PKCE exchange\nAuth complete — no code paste needed]
    LocalCallbackCheck -- No → redirect blocked --> PasteCodeFallback[Browser stayed at platform.claude.com\nor shows code in URL bar\n'Paste code here if prompted >']
    PasteCodeFallback --> DeliverCode[Guardian reads code from browser via UIA\nDelivers via terminal_send to TUI]
    DeliverCode --> TUIUnlocked_A

    ManualURL --> GuardianOpens[Guardian calls browser_open(MANUAL URL)\nwmux managed browser — fully visible\nbut MANUAL URL → platform.claude.com callback\nnot LOCAL server]
    GuardianOpens --> PasteCodeFallback

    TUIUnlocked_A --> RCBlastRadius[⚡ MACHINE-WIDE blast-radius:\n~/.claude/.credentials.json updated globally\nEVERY running Claude Code agent on this machine\nsimultaneously receives RC disconnect banner:\n'Remote Control disconnected — signed-in account\nor organization changed on this machine']
    RCBlastRadius --> RCSweep[Coordinator role (rabbit-0/dispatcher):\npane_list ALL live agent surfaces\nCheck each pane for '/rc failed' indicator\n(visible in pane lower-right corner)\nterminal_send /remote-control ONLY to panes showing that indicator\nexactly once per pane, exactly once per login\nno guessing, no preemptive spamming]
    RCSweep --> TabCleanup[TabCleanup quest:\nClose OS-launched tab in default browser\nUIA can close via window/tab automation\nFailure modes: wrong tab index, already\nnavigated, closing whole window]
```

**Note on the AlreadyAuth CONFIRMED line above**: that was observed on a session already logged in as the account it already had. The trace below is the real, deliberately UNauthenticated case, mapped end to end, and then completed all the way through a real dance (see Completed Real Dance Trace section at the end of this doc).

**Evidence to date (2026-09-23):**
- `AlreadyAuth → Yes → LoginConfirmed` **[CONFIRMED]**: sent `/login` to rabbit-1's already-authenticated session, received "Login successful" immediately, no TUI lock, no browser.
- `AlreadyAuth → No → MethodMenu` **[CONFIRMED]**: Meridian (w14-1) navigated unauthenticated rabbit-1 (daemon-f71aee79) into /login via split-call terminal_send. Saw 3-way method selection menu with sub-branches:

```mermaid
flowchart TD
    M0([/login — unauthenticated]) --> Menu{Select login method}
    Menu -- 1. Claude account\nw/ subscription --> M1[Opening browser to sign in…\nprints MANUAL URL\nTUI LOCKED from here]
    Menu -- 2. Anthropic Console\naccount --> M2{How to sign in?}
    Menu -- 3. 3rd-party platform --> M3{Which platform?}

    M2 -- 1. Sign in with\nConsole account --> M2a[not yet traced]
    M2 -- 2. Create API key\nlegacy --> M2b[not yet traced]
    M2 -- 3. Go back --> Menu

    M3 -- 1. Amazon Bedrock --> M3a[interactive — not yet traced]
    M3 -- 2. Microsoft Foundry --> M3b[opens docs URL only\nno interactive flow]
    M3 -- 3. Google Vertex AI --> M3c[interactive — not yet traced]
    M3 -- 4. Go back --> Menu

    Menu -- Esc --> Cancelled([Login interrupted\nclean return to normal chat])
```

- `Option 1 → TUI LOCKED` **[CONFIRMED]**: TUI lock begins at option selection. "Go back" clean at every depth. Escape clean at every depth ("Login interrupted"). (Meridian 2026-09-23)
- `AuthAlreadySaved=false (cookie-presence)` **[CONFIRMED]**: live claude.ai cookies in wmux browser did NOT skip OAuth — showed fresh Log-in page. Cookie presence ≠ saved auth for this flow. Only reliable check: real page content after navigation. (Meridian 2026-09-23)
- `CLIBrowserAttempt` **[CONFIRMED]**: Option 1 outputs `✽ Opening browser to sign in…` — OS-level ShellExecuteW to default browser. Happens outside wmux. If browser is already running, IPC routes new tab with no new PID. (Meridian 2026-09-23)
- ~~`Entry A = MANUAL-only`~~ **[RETRACTED — rabbit-0 error]**: OS-level launch uses LOCAL URL (redirect_uri=http://localhost:PORT). TUI-printed text is the MANUAL fallback only. Primary path = LOCAL callback, same structure as Entry B. (Meridian, UIA address-bar read, 2026-09-23)
- `Entry A LOCAL URL` **[CONFIRMED]**: DuckDuckGo address bar showed `redirect_uri=http%3A%2F%2Flocalhost%3A57715%2Fcallback` — live local port. (Meridian 2026-09-23)
- `AuthSavedInProfile is profile-specific` **[CONFIRMED]**: dariensirius logged in to claude.ai in DuckDuckGo → Authorize screen immediately. Same domain in clean wmux browser profile → Login page. Profile determines saved auth, not domain. (Meridian 2026-09-23)
- `UIA reads OS default browser` **[CONFIRMED]**: `System.Windows.Automation` PowerShell reads DuckDuckGo address bar and page content. No CDP/debug port. (Meridian 2026-09-23)
- `UIA InvokePattern fails on Chromium/CEF` **[CONFIRMED]**: DuckDuckGo is Chromium/CEF. InvokePattern threw non-terminating "Unrecognized error" — script printed success anyway (false positive). No click actually occurred. (Meridian 2026-09-23, seq 82)
- `Coordinate click works` **[CONFIRMED]**: Win32 SetCursorPos + mouse_event at button BoundingRectangle center (960,874) clicked Authorize successfully. Address bar → `platform.claude.com/oauth/code/success?app=claude-code`. (Meridian 2026-09-23)
- `LOCAL callback auto-received` **[CONFIRMED]**: rabbit-1 TUI showed "Logged in as dariensirius@protonmail.com / Login successful" automatically after coordinate click — no code paste needed. (Meridian 2026-09-23)
- `Weighted graph principle` **[DESIGN]**: user-required steps get maximum edge weight; minimizer skips them when an agent-only path exists. Minimum-cost path here: UIA coordinate click → Authorize → LOCAL callback auto-received. Zero human steps. (Victor, 2026-09-23)
- `Vessel, not participant` **[LESSON]**: a dance vessel is infrastructure, not a collaborator. Check `agentStatus: "complete"` via pane_list before using their terminal. Do not ask courtesy permission — send the command directly. Reserve consent framing for peers whose judgment is being asked for. (Victor direct, 2026-09-23)

---

## Entry B: `claude auth login --email` (in a shell)

```mermaid
flowchart TD
    EntryB([claude auth login\n--email ACCOUNT\nin shell]) --> LoginInitiated_B[TUI LOCKED\nCLI outputs LOCAL + MANUAL URLs]
    LoginInitiated_B --> SharedFlow2([→ join at URLsGenerated])
```

This is the path fully documented in README.md (Flow A / Flow B).

---

## Full Decision Tree (from quota warning through shared flow)
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

8. **CLI's own browser launch is a guardian blind spot** — Entry A (`/login`) attempts an OS-level browser open (`✽ Opening browser to sign in…`) completely outside wmux. If the user's browser is already open, a new tab silently appears via IPC (no new process, not visible to pane_list/browser_tabs). Guardian cannot detect whether it succeeded. Guardian's own `browser_open` call is the only browser action the guardian can see and control.

9. **Do not collapse the default-browser variable** — The CLI uses Windows `ShellExecuteW(url)` which routes to whatever browser holds `HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice\ProgId`. On this machine that ProgId resolves to **DuckDuckGo Browser** (`DuckDuckGo.DesktopBrowser_0.172.4.0_x64`), not Chrome or Firefox. Pre-dance recon must read this registry key to know which browser to monitor. Checking for specific browser PIDs is an unchecked assumption — a grave sin in phase-space mapping.

10. **Entry A primary callback is LOCAL (localhost:PORT), not code-paste** — ~~RETRACTED (rabbit-0, seq 70-74)~~. Entry A's OS-level browser launch uses the LOCAL URL variant (`redirect_uri=http://localhost:PORT/callback`). The TUI-printed MANUAL URL is a display-only fallback. After Authorize, the browser follows the localhost redirect automatically — the TUI local server receives the PKCE callback with no human paste step. Code-paste (`Paste code here if prompted >`) is a FALLBACK node only reached if `LocalCallbackCheck` fails (redirect blocked). Confirmed via UIA: DuckDuckGo address bar showed `localhost:57715` after OS-launch (Meridian, 2026-09-23).

11. **Pre-dance identity verification required** — Before starting any dance, run `claude auth status` (or equivalent) on the dancing agent to confirm its CURRENT account. The dance must end on a DIFFERENT account than it started on — one whose 5h/7d limits haven't been hit. A dance that starts and ends on the same account (`start-node = end-node` in account space) provides mechanical validation of the browser/UIA automation path but delivers ZERO quota relief. The 2026-09-23 real dance was a self-loop: rabbit-1 started as `dariensirius@protonmail.com` (workspace default) and ended as `dariensirius@protonmail.com` — the same account. Pre-condition check: `current_account != target_account`.

12. **Post-dance RC blast-radius — coordinator sweep on `/rc failed` signal** — A successful cross-account auth updates `~/.claude/.credentials.json` globally. Every Claude Code process on this machine reads from the same file. Immediately after `TUIUnlocked_A`, ALL running agents simultaneously receive: `● Remote Control disconnected — signed-in claude.ai account or organization changed on this machine — run /remote-control to start a session for the current account`. Each affected pane shows `/rc failed` in its **lower-right corner** — this is the reliable signal. The coordinator (rabbit-0/dispatcher) protocol: (1) `pane_list` all live agent surfaces, (2) `terminal_send("/remote-control")` to each pane that shows `/rc failed`, (3) exactly once per pane, exactly once per login — no guessing, no preemptive spamming. A dance without the RC sweep leaves every agent whose pane shows `/rc failed` deaf.

13. **Entry A tab-spam vs Entry B guardian control** — Entry A (`/login`) auto-launches a browser tab in the OS default browser (DuckDuckGo, Edge, whatever). That tab is outside wmux visibility and creates a tab cleanup burden with many failure modes. Entry B (`claude auth login --email` in a shell) does NOT auto-launch a browser — the guardian calls `browser_open(LOCAL_URL)` explicitly, has full lifecycle control, and closes the tab cleanly with `pane_close`. For agent-driven dances, Entry B is architecturally superior. Entry A's side-effect tab is only completable by the human (or non-wmux OS automation not on this toolchain).

14. **QuotaExhausted — cross-cutting fault at every dance node** — At ANY node where a dancing or coordinating agent is consuming tokens, quota can hit 0. This is not a single edge — it is a system-wide fault that can interrupt any in-progress node. Two resolution paths:

  **Path 1 — Wait for reset:** Dancing agent goes silent. TUI may stay locked. System waits for `fiveHourResetsAt` or `sevenDayResetsAt`. Auto-recovery only if a ScheduleWakeup loop fires in time AND the waking instance has enough compacted context to resume. Without those, the system is paralyzed until a human arrives.

  **Path 2 — External intervention:** Another agent (on a fresh quota account) or human detects dancer silence via `terminal_read`, identifies the stalled dance node, and either: (a) aborts the original dance (Escape/close TUI) and restarts with a fresh agent, or (b) resumes from the stall point if state is recoverable. External entity then runs RC sweep on all affected panes and notifies agents of new account.

  **The meta-level trap:** The coordinator (rabbit-0) can also hit quota mid-sweep. A partially-swept RC state is worse than no sweep — some agents reconnected, others showing `/rc failed`. Mitigation: coordinator must be on a DIFFERENT quota account than the dancer, or have confirmed headroom before starting the sweep.

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

## Account Rotation Scheduler

The dance is cyclic. Each account's `fiveHourResetsAt` is the next opportunity to switch BACK to it. The coordinator tracks all accounts and triggers the next dance when `current_account.5h > threshold` AND a depleted account's reset is imminent.

**Live rotation table** (update at each quota sample):

| Account | Flow | 5h % | 5h Reset | 7d % | 7d Reset | Status |
|---|---|---|---|---|---|---|
| dariensirius@protonmail.com | A (magic link) | ~100% | 20:20 / ts 1790220000 | ~12% | 2026-09-30 | ⏰ NEXT — dance back at reset |
| ottopoet.thesean@gmail.com | B (Gmail OAuth) | 13% | 23:20 / ts 1790230800 | 27% | 2026-09-24 18h | ✅ ACTIVE |
| claude.anthropic@aurora.wordgarden.dev | A (magic link) | unknown | unknown | unknown | unknown | 🔵 STANDBY |

**Trigger logic:**
- `next_dance_target` = account with minimum `fiveHourResetsAt` among depleted (>90%) accounts
- `dance_deadline` = `next_dance_target.fiveHourResetsAt - dance_duration_buffer` (10 min buffer)
- Right now: next dance deadline = **20:10 local** (back to dariensirius, ~1h40m)

**Rotation cycle (canonical order):**
```
dariensirius@protonmail.com (A) → claude.anthropic@aurora.wordgarden.dev (B) → ottopoet.thesean@gmail.com (C) → A
```
Skip accounts with <5h headroom or unknown state. Always check current_account ≠ target before initiating.

**Planned refactor** (seq 110): This FLOWCHART.md is the navigator's decision view. Companion files to build:
- `SEQUENCE.md` — UML sequence diagram with per-actor swimlanes (Coordinator, Dancer, Browser/UIA, CLI/TUI, CredentialFile, AllOtherAgents, EmailProvider)
- Per-actor state machines (mermaid stateDiagram-v2) for DancerSM, GuardianSM, QuotaSM, CredentialFileSM

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


---

## Completed Real Dance Trace (2026-09-23/24) — Entry A, full success

First fully-executed `/login` dance in this workspace, on a real live agent's own surface (rabbit-1, `daemon-f71aee79`), Victor observing/authorizing at the credential-consequential fork. Every claimed step below was independently re-verified, not trusted from its own script output — see the InvokePattern failure below for why that discipline mattered.

```mermaid
flowchart TD
    A[/login on live surface] --> B[Select 1: Claude subscription]
    B --> C[TUI: Opening browser to sign in…\nprints MANUAL URL as fallback display]
    C --> D[OS ShellExecuteW uses LOCAL URL\nredirect_uri=localhost:PORT/callback\nreal port confirmed 57715]
    D --> E{Windows default browser\nHKCU UrlAssociations UserChoice}
    E --> F[DuckDuckGo Browser\nNOT chrome/firefox — verify, don't assume]
    F --> G{Profile already has\nclaude.ai session?}
    G -- Yes --> H[Authorize screen shown directly\nAuthSavedInProfile=TRUE]
    G -- No --> I[Fresh Log-in page\nAuthSavedInProfile=FALSE\nreal human step required]
    H --> J[UIA sample: read address bar + buttons\nconfirm code_challenge/state match TUI-printed values]
    J --> K{Click Authorize}
    K -- InvokePattern.Invoke --> L[FAILS SILENTLY on Chromium/CEF UI\n'Unrecognized error' — non-terminating,\nscript can falsely report success if\nno try/catch around it]
    K -- Real synthetic mouse click\nSetCursorPos + mouse_event\nat BoundingRectangle center --> M[WORKS — verified by re-reading\naddress bar after: success page]
    M --> N[Local server auto-receives callback\nno manual code paste needed]
    N --> O[TUI: Logged in as EMAIL\nLogin successful. Press Enter to continue…]
    O --> P[Enter dismisses\nsurface returns to clean idle prompt\nno leftover state, same session]
```

**Real findings, each independently verified in this run:**

1. **Entry A DOES use a LOCAL callback URL**, same as Entry B — corrects an earlier same-session finding ("Entry A = MANUAL only") that was itself wrong. The TUI's printed URL is a fallback display; the actual OS-level auto-open call uses the LOCAL variant with a real listening port the whole time.

2. **`AuthSavedInProfile` is the correct graph variable, not a domain-level fact.** Same `claude.ai`/`claude.com` OAuth flow gave opposite answers in two different browser profiles on the same machine in the same session (a clean wmux-managed CDP browser: fresh login page; the OS-default DuckDuckGo profile: straight to Authorize). Check the actual profile being used, never assume from domain alone.

3. **Windows UI Automation (`System.Windows.Automation`, PowerShell) can read a non-wmux, non-CDP external browser window** — address bar, page text, buttons — by PID, with no remote-debugging port or special launch flags needed. This is the real bridge across the "guardian can't see the OS auto-open" blind spot flagged earlier in this doc.

4. **`InvokePattern.Invoke()` is unreliable on Chromium/CEF-hosted UI** (confirmed on DuckDuckGo Browser, itself Chromium-based) — it can throw `"Unrecognized error"` while a script continues past it and falsely reports success if the failure isn't checked. **Real fix: use a synthetic mouse click at the element's actual `BoundingRectangle` center** (Win32 `SetCursorPos` + `mouse_event`, saving and restoring the real cursor position afterward) instead of InvokePattern, for this class of browser UI specifically. Always re-verify post-click state (re-read address bar / button set) rather than trusting the click call's own return.

5. **Weighted-graph framing (Victor, seq 78) matches this run exactly**: `AuthSavedInProfile=TRUE` was the zero-human-step, minimum-cost edge, and it's the one this real dance happened to be on. The `FALSE` branch (fresh login page) remains untested end-to-end in this session — it requires a real human credential/2FA step and should stay high-weight in any future minimization pass.

**Open, unresolved (flagged, not solved this session):** the now-completed OAuth flow leaves a real browser window open on the physical desktop (DuckDuckGo, showing the "You're all set up" success page). Victor named this precisely: *"each login dance spams an open tab to the user's default browser... countless failure cases in the 'clean up the tab you launched' quest line"* — wrong-browser assumptions, wrong-tab-index assumptions, closing without focusing, closing the whole browser instead of one tab. This session deliberately did NOT attempt automated cleanup of that window — left open, flagged to Victor, not closed on inference. A real close-verification protocol (confirm PID, confirm it's the same window opened for this exact dance via title/URL re-check immediately before closing, close via the same UIA path rather than guessing a hotkey) is real future work, not yet built.
