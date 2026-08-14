'use strict';

/**
 * Hybrid Instagram profile backup.
 *
 * A real Chromium browser (Playwright) opens the profile and scrolls the wall.
 * As the page loads, Instagram's own JSON API responses are intercepted; those
 * payloads contain direct full-res image URLs and direct .mp4 video URLs, which
 * are then downloaded straight to disk. This gives browser-level realism plus
 * clean, playable video files.
 *
 * Posts only (photos / videos / carousels). Captions are intentionally not saved.
 */

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

// In the dev container Chromium is pre-installed; in the Docker image the
// Playwright base image provides it at the default location. CHROMIUM_PATH lets
// the dev container point at the pre-installed binary.
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || undefined;

// Overridable so the pipeline can be tested against a local mock.
const BASE_URL = process.env.IG_BASE_URL || 'https://www.instagram.com';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function launch() {
  return chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
}

// --- Media extraction ------------------------------------------------------
// Walk an arbitrary JSON tree and collect every media node we recognise.
// A node is "media" when it exposes image_versions2 / video_versions (mobile
// API shape) or display_url / display_resources (GraphQL shape).
function extractMedia(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) extractMedia(child, out, seen);
    return;
  }

  const hasVideo = Array.isArray(node.video_versions) && node.video_versions.length > 0;
  const videoUrlField = typeof node.video_url === 'string' ? node.video_url : null;
  const imgCandidates =
    node.image_versions2 && Array.isArray(node.image_versions2.candidates)
      ? node.image_versions2.candidates
      : null;
  const displayResources = Array.isArray(node.display_resources)
    ? node.display_resources
    : null;
  const displayUrl = typeof node.display_url === 'string' ? node.display_url : null;

  if (hasVideo || videoUrlField) {
    const url = hasVideo ? node.video_versions[0].url : videoUrlField;
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ type: 'video', url });
    }
  } else if (imgCandidates || displayResources || displayUrl) {
    let url = null;
    if (imgCandidates && imgCandidates.length) {
      // Candidates are largest-first.
      url = imgCandidates[0].url;
    } else if (displayResources && displayResources.length) {
      url = displayResources[displayResources.length - 1].src;
    } else {
      url = displayUrl;
    }
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ type: 'image', url });
    }
  }

  // Recurse into children (carousel_media, edges, nodes, items, …).
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') extractMedia(value, out, seen);
  }
}

function filenameFor(url) {
  const clean = url.split('?')[0].split('#')[0];
  let base = path.basename(clean);
  if (!base || base === '/') base = 'media';
  // Strip anything unsafe for a filename.
  base = base.replace(/[^a-zA-Z0-9._-]/g, '_');
  return base;
}

function ensureExt(name, type) {
  if (/\.[a-zA-Z0-9]{2,4}$/.test(name)) return name;
  return name + (type === 'video' ? '.mp4' : '.jpg');
}

// Instagram server-renders the first page of posts as JSON inside
// <script type="application/json"> tags. Parse those so small profiles (whose
// posts never trigger an XHR) are still captured.
async function harvestEmbedded(page, media, seen) {
  const blobs = await page
    .$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent))
    .catch(() => []);
  for (const blob of blobs) {
    try {
      extractMedia(JSON.parse(blob), media, seen);
    } catch (_) {
      /* not JSON media */
    }
  }
}

// Ask Instagram's own web API (from inside the logged-in page, so cookies and
// headers are real) for the profile's first page of posts. The X-IG-App-ID
// value is the long-stable public web app id.
async function harvestWebProfileInfo(page, username, media, seen) {
  const json = await page
    .evaluate(async (user) => {
      try {
        const res = await fetch(
          `/api/v1/users/web_profile_info/?username=${encodeURIComponent(user)}`,
          { headers: { 'X-IG-App-ID': '936619743392459' }, credentials: 'include' }
        );
        if (!res.ok) return null;
        return await res.json();
      } catch (_) {
        return null;
      }
    }, username)
    .catch(() => null);
  if (json) extractMedia(json, media, seen);
  return json;
}

// --- Login -----------------------------------------------------------------
async function performLogin(context, page, creds, log) {
  log('Logging in…');
  await page.goto(`${BASE_URL}/accounts/login/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });

  // Cookie consent banners appear in some regions.
  for (const label of ['Allow all cookies', 'Accept All', 'Only allow essential cookies']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click().catch(() => {});
      break;
    }
  }

  await page.fill('input[name="username"]', creds.user, { timeout: 30000 });
  await page.fill('input[name="password"]', creds.password);
  await page.click('button[type="submit"]');

  // Optional 2FA step.
  if (creds.code) {
    const codeInput = page.locator('input[name="verificationCode"]');
    if (await codeInput.count().catch(() => 0)) {
      log('Entering 2FA code…');
      await codeInput.fill(creds.code);
      await page.getByRole('button', { name: /confirm|continue|submit/i }).first().click().catch(() => {});
    }
  }

  await page.waitForTimeout(4000);

  // Dismiss "Save your login info?" / "Turn on notifications" prompts.
  for (const label of ['Not now', 'Not Now']) {
    const btn = page.getByRole('button', { name: label });
    if (await btn.count().catch(() => 0)) {
      await btn.first().click().catch(() => {});
      await page.waitForTimeout(1000);
    }
  }

  // Detect failure: still showing the password field, or an error message.
  const stillOnLogin = await page.locator('input[name="password"]').count().catch(() => 0);
  if (stillOnLogin) {
    const err = await page
      .locator('[role="alert"], #slfErrorAlert')
      .first()
      .textContent()
      .catch(() => null);
    throw new Error(
      'Instagram login failed' +
        (err ? `: ${err.trim()}` : '. Check the credentials, or the account may need a 2FA code or be blocked by a security challenge.')
    );
  }
  log('Login successful.');
}

// --- Main ------------------------------------------------------------------
async function backupProfile(opts) {
  const {
    profile,
    creds, // { user, password, code } or null
    outputDir, // per-profile directory
    sessionDir, // where session cookie files live
    onProgress = () => {},
    onLog = () => {},
  } = opts;

  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = creds ? path.join(sessionDir, `${creds.user}.json`) : null;

  const browser = await launch();
  const media = [];
  const seen = new Set();
  let jsonResponses = 0;

  try {
    const contextOpts = {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 900 },
    };
    if (sessionFile && fs.existsSync(sessionFile)) {
      contextOpts.storageState = sessionFile;
      onLog('Reusing saved session.');
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    // Intercept JSON responses that carry timeline media.
    page.on('response', async (response) => {
      try {
        const ct = (response.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        // Instagram renames its media endpoints often, so parse every JSON
        // response and let the extractor decide what's media.
        jsonResponses++;
        const json = await response.json().catch(() => null);
        if (!json) return;
        const before = media.length;
        extractMedia(json, media, seen);
        if (media.length > before) {
          onProgress({ found: media.length });
        }
      } catch (_) {
        /* ignore malformed responses */
      }
    });

    // Log in if needed.
    if (creds && !(sessionFile && fs.existsSync(sessionFile))) {
      await performLogin(context, page, creds, onLog);
      await context.storageState({ path: sessionFile });
    }

    onLog(`Opening @${profile}…`);
    const resp = await page.goto(`${BASE_URL}/${encodeURIComponent(profile)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });

    if (resp && resp.status() === 404) {
      throw new Error(`Profile @${profile} not found.`);
    }

    await sleep(2500); // let the initial page settle

    // A login wall means IG is refusing anonymous access (very common now) or
    // the profile is private. Detect via a redirect to the login page or a
    // visible login form.
    const onLoginPage =
      page.url().includes('/accounts/login') ||
      (await page.locator('input[name="password"]').count().catch(() => 0)) > 0;
    if (onLoginPage) {
      throw new Error(
        creds
          ? 'Instagram redirected to a login wall even after login — the session may have expired or been challenged. Try again.'
          : 'Instagram is blocking anonymous access to this profile (a login wall appeared). Expand "Login" and provide your credentials, then try again.'
      );
    }

    // 1) First page of posts embedded in the HTML.
    await harvestEmbedded(page, media, seen);
    // 2) First page via Instagram's own web API (robust to layout changes).
    await harvestWebProfileInfo(page, profile, media, seen);
    if (media.length) onProgress({ found: media.length });

    onLog('Scrolling the wall to load the rest of the posts…');
    // Scroll until no new media appears for several rounds; re-harvest embedded
    // JSON each round as a fallback to the intercepted XHRs.
    let stableRounds = 0;
    let lastCount = media.length;
    for (let i = 0; i < 400 && stableRounds < 5; i++) {
      await page.mouse.wheel(0, 4000);
      await sleep(1400);
      await harvestEmbedded(page, media, seen);
      if (media.length === lastCount) {
        stableRounds++;
      } else {
        stableRounds = 0;
        lastCount = media.length;
        onProgress({ found: media.length });
      }
    }

    onLog(
      `Saw ${jsonResponses} data response(s); discovered ${media.length} media item(s).`
    );
    if (media.length === 0) {
      throw new Error(
        (creds
          ? 'Logged in, but no posts were found. '
          : 'No posts were found (Instagram often requires login — expand "Login" and try again). ') +
          'The account may be empty/private, or Instagram changed their page format.'
      );
    }
    onLog('Downloading…');

    // Download each media file using the browser context (reuses cookies).
    let downloaded = 0;
    const usedNames = new Set();
    for (const item of media) {
      let name = ensureExt(filenameFor(item.url), item.type);
      while (usedNames.has(name)) name = `_${name}`;
      usedNames.add(name);
      const dest = path.join(outputDir, name);

      if (fs.existsSync(dest)) {
        downloaded++;
        onProgress({ found: media.length, downloaded });
        continue;
      }

      try {
        const res = await context.request.get(item.url, { timeout: 60000 });
        if (res.ok()) {
          const buf = await res.body();
          fs.writeFileSync(dest, buf);
          downloaded++;
        }
      } catch (_) {
        /* skip a file that fails to download */
      }
      onProgress({ found: media.length, downloaded });
    }

    onLog(`Done. Saved ${downloaded} of ${media.length} file(s).`);
    return { found: media.length, downloaded };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { backupProfile, extractMedia, filenameFor, ensureExt };
