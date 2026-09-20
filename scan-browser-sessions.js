#!/usr/bin/env node
/**
 * scan-browser-sessions.js
 *
 * Detects which browsers on this machine have Google accounts pre-populated,
 * at two distinct layers:
 *
 *   Layer 1 — profile metadata (fast, offline, INCOMPLETE):
 *     Reads Chrome/Brave/Edge/Firefox profile sign-in files. Finds the account
 *     that "owns" each browser profile. MISSES accounts active via session
 *     cookies that are not the profile-owning account.
 *
 *   Layer 2 — session cookies (ground truth, requires --cookies flag):
 *     Reads the SQLite Cookies database in each browser profile. Detects
 *     presence of accounts.google.com session cookies (APISID, SAPISID, SID…).
 *     Cannot resolve email addresses — cookie values are DPAPI-encrypted on
 *     Windows. Reports "has active Google sessions — navigate to
 *     accounts.google.com to see which accounts."
 *
 * DO NOT confuse these layers. Victor's ground truth (a screenshot of Brave's
 * Google "Choose an account" picker showing ottopoet.thesean@gmail.com) proved
 * Layer 1 was wrong: Brave's profile metadata said "no Google account" but its
 * session cookies had two active accounts. Layer 1 looks at the wrong thing.
 *
 * Usage:
 *   node scan-browser-sessions.js                    # Layer 1 only
 *   node scan-browser-sessions.js --cookies          # Layer 1 + Layer 2
 *   node scan-browser-sessions.js --find EMAIL       # Layer 1 search for email
 *   node scan-browser-sessions.js --cookies --json   # machine-readable
 *
 * Cross-platform: no hardcoded usernames or paths (uses os.homedir(),
 * process.env.LOCALAPPDATA, XDG_CONFIG_HOME). Works on Windows, macOS, Linux.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const args = process.argv.slice(2);
const findEmail = args.includes('--find') ? args[args.indexOf('--find') + 1] : null;
const jsonOutput = args.includes('--json');
const checkCookies = args.includes('--cookies');

// ── OS-agnostic base path resolution ────────────────────────────────────────

function browserBasePaths() {
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return {
      chrome:   path.join(local,   'Google', 'Chrome', 'User Data'),
      brave:    path.join(local,   'BraveSoftware', 'Brave-Browser', 'User Data'),
      edge:     path.join(local,   'Microsoft', 'Edge', 'User Data'),
      opera:    path.join(roaming, 'Opera Software', 'Opera Stable'),
      vivaldi:  path.join(local,   'Vivaldi', 'User Data'),
      firefox:  path.join(roaming, 'Mozilla', 'Firefox'),
    };
  } else if (platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return {
      chrome:   path.join(appSupport, 'Google', 'Chrome'),
      brave:    path.join(appSupport, 'BraveSoftware', 'Brave-Browser'),
      edge:     path.join(appSupport, 'Microsoft Edge'),
      opera:    path.join(appSupport, 'com.operasoftware.Opera'),
      vivaldi:  path.join(appSupport, 'Vivaldi'),
      firefox:  path.join(home, 'Library', 'Application Support', 'Firefox'),
    };
  } else {
    // Linux / other POSIX
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    return {
      chrome:   path.join(config, 'google-chrome'),
      chromium: path.join(config, 'chromium'),
      brave:    path.join(config, 'BraveSoftware', 'Brave-Browser'),
      edge:     path.join(config, 'microsoft-edge'),
      vivaldi:  path.join(config, 'vivaldi'),
      opera:    path.join(config, 'opera'),
      firefox:  path.join(home, '.mozilla', 'firefox'),
    };
  }
}

// ── Chromium-based browser scanner (Layer 1) ────────────────────────────────

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function extractEmailFromPreferences(prefPath) {
  const data = readJsonFile(prefPath);
  if (!data) return null;
  if (Array.isArray(data.account_info) && data.account_info.length > 0) {
    return data.account_info[0].email || null;
  }
  if (data.signin && data.signin.allowed_username) {
    return data.signin.allowed_username;
  }
  return null;
}

function scanChromiumBrowser(browserName, userDataDir) {
  const results = [];
  if (!fs.existsSync(userDataDir)) return results;

  const localState = readJsonFile(path.join(userDataDir, 'Local State'));
  const infoCache = localState?.profile?.info_cache || {};

  let profileDirs = new Set(Object.keys(infoCache));
  try {
    fs.readdirSync(userDataDir).forEach(name => {
      if (name === 'Default' || /^Profile \d+$/.test(name)) profileDirs.add(name);
    });
  } catch {}

  for (const profileName of profileDirs) {
    const profilePath = path.join(userDataDir, profileName);
    if (!fs.existsSync(profilePath)) continue;

    const cachedInfo = infoCache[profileName] || {};
    const prefPath = path.join(profilePath, 'Preferences');
    const email = extractEmailFromPreferences(prefPath) || cachedInfo.user_name || null;
    const displayName = cachedInfo.name || null;

    results.push({
      browser: browserName,
      profile: profileName,
      displayName,
      email,          // Layer 1: profile sign-in account (may be null even with active sessions)
      googleSessions: null,  // Layer 2: filled by checkGoogleSessionCookies if --cookies
      profilePath,
    });
  }

  return results;
}

// ── Firefox scanner (Layer 1) ────────────────────────────────────────────────

function scanFirefox(firefoxBase) {
  const results = [];
  if (!fs.existsSync(firefoxBase)) return results;

  let profilesIni;
  try {
    profilesIni = fs.readFileSync(path.join(firefoxBase, 'profiles.ini'), 'utf8');
  } catch {
    return results;
  }

  const sections = profilesIni.split(/\[Profile\d+\]/);
  for (const section of sections) {
    const pathMatch = section.match(/^Path=(.+)$/m);
    const isRelative = /^IsRelative=1$/m.test(section);
    const nameMatch = section.match(/^Name=(.+)$/m);
    if (!pathMatch) continue;

    const rawPath = pathMatch[1].trim();
    const profilePath = isRelative
      ? path.join(firefoxBase, rawPath.replace(/\//g, path.sep))
      : rawPath;

    let email = null;
    try {
      const signedIn = JSON.parse(fs.readFileSync(path.join(profilePath, 'signedInUser.json'), 'utf8'));
      email = signedIn?.accountData?.email || null;
    } catch {}

    results.push({
      browser: 'Firefox',
      profile: nameMatch ? nameMatch[1].trim() : path.basename(profilePath),
      displayName: null,
      email,
      googleSessions: null,
      profilePath,
    });
  }

  return results;
}

// ── Layer 2: Google session cookie detection ─────────────────────────────────
//
// Strategy: copy the Cookies SQLite file to a temp path (avoids lock issues),
// then query it using available SQLite tooling.
//
// Priority order for SQLite access:
//   1. better-sqlite3 Node module (if installed, cross-platform, no subprocess)
//   2. sqlite3 Node module (if installed)
//   3. sqlite3 CLI binary on PATH (shell out)
//   4. Skip (return null = unknown)
//
// NOTE: Cookie values are DPAPI-encrypted on Windows (Chromium 80+). We can
// detect the PRESENCE of Google session cookies (row exists in the table) but
// CANNOT read the email addresses from the values without decryption.
// Use this to confirm "yes, Google sessions exist" → then navigate to
// accounts.google.com in that browser to see which accounts.

function findSQLiteBinary() {
  const candidates = ['sqlite3', 'sqlite3.exe'];
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" --version`, { stdio: 'pipe', timeout: 2000 });
      return bin;
    } catch {}
  }
  return null;
}

let _sqliteBinary = undefined;
let _betterSqlite3 = undefined;
let _sqlite3Module = undefined;

function getSQLiteMethod() {
  if (_betterSqlite3 === undefined) {
    try { _betterSqlite3 = require('better-sqlite3'); } catch { _betterSqlite3 = null; }
  }
  if (_betterSqlite3) return 'better-sqlite3';

  if (_sqlite3Module === undefined) {
    try { _sqlite3Module = require('sqlite3'); } catch { _sqlite3Module = null; }
  }
  if (_sqlite3Module) return 'sqlite3';

  if (_sqliteBinary === undefined) _sqliteBinary = findSQLiteBinary();
  if (_sqliteBinary) return 'binary';

  return null;
}

const GOOGLE_SESSION_COOKIE_NAMES = ['APISID', 'SAPISID', 'SID', 'HSID', 'SSID', 'OSID', '__Secure-1PSID', '__Secure-3PSID'];
const GOOGLE_COOKIE_QUERY = `
  SELECT COUNT(*) as cnt FROM cookies
  WHERE host_key LIKE '%.google.com'
  AND name IN ('${GOOGLE_SESSION_COOKIE_NAMES.join("','")}')
`.trim();

function copyToTemp(src) {
  const tmpDir = os.tmpdir();
  const tmpFile = path.join(tmpDir, `scan-cookies-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`);
  try {
    fs.copyFileSync(src, tmpFile);
    // Also copy WAL/SHM files if they exist
    for (const ext of ['-wal', '-shm']) {
      const walSrc = src + ext;
      if (fs.existsSync(walSrc)) fs.copyFileSync(walSrc, tmpFile + ext);
    }
    return tmpFile;
  } catch {
    return null;
  }
}

function queryGoogleCookiesBinary(dbPath, bin) {
  try {
    const result = execSync(
      `"${bin}" "${dbPath}" "${GOOGLE_COOKIE_QUERY}"`,
      { stdio: 'pipe', timeout: 5000, encoding: 'utf8' }
    ).trim();
    return parseInt(result, 10) > 0;
  } catch {
    return null;
  }
}

function findCookieFile(profilePath) {
  // Chromium 96+ moved the Cookies database to a Network subdirectory.
  // Check new location first, fall back to legacy location.
  const newPath = path.join(profilePath, 'Network', 'Cookies');
  if (fs.existsSync(newPath)) return newPath;
  const oldPath = path.join(profilePath, 'Cookies');
  if (fs.existsSync(oldPath)) return oldPath;
  return null;
}

function checkGoogleSessionCookies(profilePath, browser) {
  // Firefox doesn't use Chrome-style Cookies SQLite for Google
  if (browser === 'Firefox') return null;

  const cookieFile = findCookieFile(profilePath);
  if (!cookieFile) return null;

  const method = getSQLiteMethod();
  if (!method) return null;  // no SQLite tooling available

  const tmpDb = copyToTemp(cookieFile);
  if (!tmpDb) return null;

  try {
    if (method === 'better-sqlite3') {
      const db = _betterSqlite3(tmpDb, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare(GOOGLE_COOKIE_QUERY).get();
        return row && row.cnt > 0;
      } finally {
        db.close();
      }
    }

    if (method === 'sqlite3') {
      // sqlite3 module is callback-based — not easily usable synchronously here
      // Fall through to binary method
      return null;
    }

    if (method === 'binary') {
      return queryGoogleCookiesBinary(tmpDb, _sqliteBinary);
    }

    return null;
  } catch {
    return null;
  } finally {
    // Clean up temp copy and WAL/SHM files
    for (const ext of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(tmpDb + ext); } catch {}
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const paths = browserBasePaths();
  let allResults = [];

  const chromiumBrowsers = { ...paths };
  delete chromiumBrowsers.firefox;
  for (const [name, dir] of Object.entries(chromiumBrowsers)) {
    allResults.push(...scanChromiumBrowser(name, dir));
  }
  if (paths.firefox) allResults.push(...scanFirefox(paths.firefox));

  // Layer 2: check session cookies if requested
  if (checkCookies) {
    const sqliteMethod = getSQLiteMethod();
    if (!sqliteMethod && !jsonOutput) {
      console.error('⚠️  No SQLite tooling found (better-sqlite3, sqlite3, or sqlite3 binary). --cookies requires one of these.');
    }
    for (const r of allResults) {
      r.googleSessions = checkGoogleSessionCookies(r.profilePath, r.browser);
    }
  }

  // Filter for --find
  let filtered = allResults;
  if (findEmail) {
    filtered = allResults.filter(r => {
      if (r.email && r.email.toLowerCase() === findEmail.toLowerCase()) return true;
      // Check raw Preferences content as fallback (catches some extra cases)
      const prefPath = path.join(r.profilePath, 'Preferences');
      try {
        if (fs.existsSync(prefPath) && fs.readFileSync(prefPath, 'utf8').includes(findEmail)) {
          r.email = `${findEmail} (found in Preferences text, not confirmed primary account)`;
          return true;
        }
      } catch {}
      return false;
    });
  }

  if (jsonOutput) {
    console.log(JSON.stringify(
      filtered.map(r => ({ ...r, profilePath: undefined })),
      null, 2
    ));
    return;
  }

  if (filtered.length === 0) {
    if (findEmail) {
      console.log(`Layer 1 result: "${findEmail}" not found in any browser profile metadata on this machine.`);
      if (!checkCookies) console.log('Try --cookies to check session cookies (detects accounts active without profile sign-in).');
    } else {
      console.log('No browser profiles found.');
    }
    return;
  }

  if (findEmail) console.log(`Searching for: ${findEmail}\n`);

  const byBrowser = {};
  for (const r of filtered) {
    if (!byBrowser[r.browser]) byBrowser[r.browser] = [];
    byBrowser[r.browser].push(r);
  }

  const cookieMethodName = getSQLiteMethod() || 'none';

  for (const [browser, profiles] of Object.entries(byBrowser)) {
    console.log(`\n${browser}`);
    console.log('─'.repeat(browser.length));
    for (const p of profiles) {
      const name = p.displayName ? ` (${p.displayName})` : '';
      const layer1 = p.email || '(no profile sign-in — Layer 1 blind here)';
      let line = `  ${p.profile}${name}: ${layer1}`;

      if (checkCookies) {
        if (p.googleSessions === true) {
          line += '  ✅ Google session cookies present → navigate to accounts.google.com to see which accounts';
        } else if (p.googleSessions === false) {
          line += '  ⬜ No Google session cookies';
        } else if (p.googleSessions === null && p.browser === 'Firefox') {
          line += '  — (Firefox: separate cookie format, skipped)';
        } else {
          line += '  ❓ Cookie check inconclusive (no Cookies file, or locked, or no SQLite tooling)';
        }
      }

      console.log(line);
    }
  }

  if (checkCookies) {
    console.log(`\n[Layer 2 cookie check used: ${cookieMethodName}]`);
    console.log('[Cookie values are encrypted — only presence detected, not email addresses]');
    console.log('[Ground truth: navigate to accounts.google.com in any browser with ✅ to see which accounts]');
  } else if (!findEmail) {
    console.log('\n[Run with --cookies to also check for active Google sessions (not just profile sign-in)]');
  }
}

main();
