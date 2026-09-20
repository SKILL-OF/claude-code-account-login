#!/usr/bin/env node
/**
 * scan-browser-sessions.js
 *
 * Finds which browsers on this machine have which Google (or other) accounts
 * pre-populated, based on profile metadata and Preferences files.
 * OS-agnostic: works on Windows, macOS, Linux without hardcoding usernames or paths.
 *
 * Usage:
 *   node scan-browser-sessions.js                    # list all accounts in all browsers
 *   node scan-browser-sessions.js --find EMAIL       # find which browser has EMAIL
 *   node scan-browser-sessions.js --json             # machine-readable output
 *
 * Output: browser, profile name, email, profile path
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const args = process.argv.slice(2);
const findEmail = args.includes('--find') ? args[args.indexOf('--find') + 1] : null;
const jsonOutput = args.includes('--json');

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

// ── Chromium-based browser scanner ──────────────────────────────────────────

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

  // account_info array (most reliable for signed-in Chrome profiles)
  if (Array.isArray(data.account_info) && data.account_info.length > 0) {
    return data.account_info[0].email || null;
  }

  // signin.allowed_username fallback
  if (data.signin && data.signin.allowed_username) {
    return data.signin.allowed_username;
  }

  return null;
}

function scanChromiumBrowser(browserName, userDataDir) {
  const results = [];
  if (!fs.existsSync(userDataDir)) return results;

  // Read Local State for profile list
  const localState = readJsonFile(path.join(userDataDir, 'Local State'));
  const infoCache = localState?.profile?.info_cache || {};

  // Also scan directories directly in case Local State is stale
  let profileDirs = new Set(Object.keys(infoCache));
  try {
    fs.readdirSync(userDataDir).forEach(name => {
      if (name === 'Default' || /^Profile \d+$/.test(name)) {
        profileDirs.add(name);
      }
    });
  } catch {}

  for (const profileName of profileDirs) {
    const profilePath = path.join(userDataDir, profileName);
    if (!fs.existsSync(profilePath)) continue;

    const cachedInfo = infoCache[profileName] || {};
    const prefPath = path.join(profilePath, 'Preferences');

    // Email: prefer Preferences file (more current), fall back to Local State cache
    const email = extractEmailFromPreferences(prefPath) || cachedInfo.user_name || null;
    const displayName = cachedInfo.name || null;

    results.push({
      browser: browserName,
      profile: profileName,
      displayName,
      email,
      profilePath,
    });
  }

  return results;
}

// ── Firefox scanner ──────────────────────────────────────────────────────────

function scanFirefox(firefoxBase) {
  const results = [];
  if (!fs.existsSync(firefoxBase)) return results;

  // Parse profiles.ini
  let profilesIni;
  try {
    profilesIni = fs.readFileSync(path.join(firefoxBase, 'profiles.ini'), 'utf8');
  } catch {
    return results;
  }

  // Extract profile paths (IsRelative + Path)
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

    // Check signedInUser.json for Firefox Account email
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
      profilePath,
    });
  }

  return results;
}

// ── Search for specific email in profile Preferences ────────────────────────

function profileContainsEmail(profilePath, email) {
  const prefPath = path.join(profilePath, 'Preferences');
  if (!fs.existsSync(prefPath)) return false;
  try {
    const content = fs.readFileSync(prefPath, 'utf8');
    return content.includes(email);
  } catch {
    return false;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const paths = browserBasePaths();
  let allResults = [];

  // Chromium-based browsers
  const chromiumBrowsers = { ...paths };
  delete chromiumBrowsers.firefox;
  for (const [name, dir] of Object.entries(chromiumBrowsers)) {
    allResults.push(...scanChromiumBrowser(name, dir));
  }

  // Firefox
  if (paths.firefox) {
    allResults.push(...scanFirefox(paths.firefox));
  }

  // If --find: also search raw Preferences content for email (catches accounts
  // with sessions but not signed into Chrome profile manager)
  if (findEmail) {
    allResults = allResults.filter(r => {
      if (r.email && r.email.toLowerCase() === findEmail.toLowerCase()) return true;
      if (!r.email && profileContainsEmail(r.profilePath, findEmail)) {
        r.email = `${findEmail} (found in Preferences, not primary profile account)`;
        return true;
      }
      return false;
    });
  }

  if (jsonOutput) {
    console.log(JSON.stringify(allResults, null, 2));
    return;
  }

  if (allResults.length === 0) {
    if (findEmail) {
      console.log(`Not found: ${findEmail} is not pre-populated in any browser profile on this machine.`);
    } else {
      console.log('No browser profiles found.');
    }
    return;
  }

  if (findEmail) {
    console.log(`Searching for: ${findEmail}\n`);
  }

  // Group by browser
  const byBrowser = {};
  for (const r of allResults) {
    if (!byBrowser[r.browser]) byBrowser[r.browser] = [];
    byBrowser[r.browser].push(r);
  }

  for (const [browser, profiles] of Object.entries(byBrowser)) {
    console.log(`\n${browser}`);
    console.log('─'.repeat(browser.length));
    for (const p of profiles) {
      const name = p.displayName ? ` (${p.displayName})` : '';
      const email = p.email || '(no Google account)';
      console.log(`  ${p.profile}${name}: ${email}`);
    }
  }
}

main();
