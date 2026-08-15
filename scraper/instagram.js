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

// Scroll tuning (troubleshooting knobs). Raise the delay/patience on slow
// connections or very large profiles so pagination isn't cut short.
const SCROLL_DELAY = parseInt(process.env.IG_SCROLL_DELAY || '2000', 10); // ms between scrolls
const SCROLL_PATIENCE = parseInt(process.env.IG_SCROLL_PATIENCE || '10', 10); // stable rounds before stopping
const MAX_SCROLLS = parseInt(process.env.IG_MAX_SCROLLS || '1500', 10); // hard cap on scroll iterations

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

// A stable identifier for a media item across runs: the CDN path basename
// (before the query string) contains a content hash that stays constant even
// though the signed URL's query parameters change on every page load.
function mediaKey(url) {
  const clean = url.split('?')[0].split('#')[0];
  return path.basename(clean) || url;
}

// Pick a file extension from the URL, falling back by media type.
function extFor(url, type) {
  const clean = url.split('?')[0].split('#')[0];
  const m = path.basename(clean).match(/\.([a-zA-Z0-9]{2,4})$/);
  if (m) return m[1].toLowerCase();
  return type === 'video' ? 'mp4' : 'jpg';
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
    const profileInfo = await harvestWebProfileInfo(page, profile, media, seen);
    if (media.length) onProgress({ found: media.length });

    // The profile's total post count (carousels count as one post), useful as a
    // reference against how many media items we end up finding.
    let totalPosts = null;
    try {
      totalPosts =
        profileInfo.data.user.edge_owner_to_timeline_media.count;
    } catch (_) {
      /* not available */
    }
    if (totalPosts != null) {
      onLog(
        `Profile reports ${totalPosts} post(s). Found ${media.length} media item(s) on the first page.`
      );
    }

    onLog('Scrolling the wall to load the rest of the posts…');
    // Stop only when BOTH the media count and the page height stay unchanged for
    // SCROLL_PATIENCE consecutive rounds — a plateau in the count alone can just
    // mean the next page is still loading.
    let stableRounds = 0;
    let lastCount = media.length;
    let lastHeight = 0;
    let stopReason = 'reached the end';
    let i = 0;
    for (; i < MAX_SCROLLS; i++) {
      // Jump to the bottom to bring the lazy-load sentinel into view…
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.mouse.wheel(0, 6000);
      await sleep(SCROLL_DELAY);
      // …then "jiggle" up and back down so IntersectionObserver-based loaders
      // fire again even when the sentinel was already on screen (a transition is
      // required to re-trigger them).
      await page.evaluate(() => window.scrollBy(0, -400)).catch(() => {});
      await sleep(250);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
      await sleep(Math.max(250, SCROLL_DELAY - 250));
      await harvestEmbedded(page, media, seen);

      const height = await page
        .evaluate(() => document.body.scrollHeight)
        .catch(() => lastHeight);
      const grewCount = media.length !== lastCount;
      const grewHeight = height !== lastHeight;

      if (!grewCount && !grewHeight) {
        stableRounds++;
      } else {
        stableRounds = 0;
        if (grewCount) onProgress({ found: media.length });
      }
      lastCount = media.length;
      lastHeight = height;

      // Progress heartbeat every few rounds so the log shows the discovery curve.
      if (i % 5 === 0) {
        onLog(
          `  scroll ${i}: ${media.length} media` +
            (totalPosts != null ? ` (of ~${totalPosts} posts)` : '') +
            `, stable ${stableRounds}/${SCROLL_PATIENCE}`
        );
      }

      if (stableRounds >= SCROLL_PATIENCE) break;
    }
    if (i >= MAX_SCROLLS) stopReason = `hit the scroll cap (${MAX_SCROLLS})`;
    onLog(`Stopped scrolling after ${i} round(s) — ${stopReason}.`);

    onLog(
      `Saw ${jsonResponses} data response(s); discovered ${media.length} media item(s)` +
        (totalPosts != null ? ` from a profile of ${totalPosts} post(s)` : '') +
        '.'
    );
    if (totalPosts != null && media.length < totalPosts) {
      onLog(
        'Fewer media than posts — pagination may have stopped early. Try raising ' +
          'IG_SCROLL_PATIENCE / IG_SCROLL_DELAY, or the profile has content this ' +
          "tool doesn't fetch (e.g. tagged posts)."
      );
    }
    if (media.length === 0) {
      throw new Error(
        (creds
          ? 'Logged in, but no posts were found. '
          : 'No posts were found (Instagram often requires login — expand "Login" and try again). ') +
          'The account may be empty/private, or Instagram changed their page format.'
      );
    }
    onLog('Downloading…');

    // Files are named "<username>_<N>.<ext>". A manifest maps each media's
    // stable key (its CDN path basename, which contains a content hash) to the
    // assigned filename, so re-running a backup keeps existing numbering and
    // only downloads new posts.
    const manifestPath = path.join(outputDir, '.manifest.json');
    let manifest = {};
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
      manifest = {};
    }
    // Continue numbering after the highest N already assigned.
    let nextIndex = 0;
    for (const assigned of Object.values(manifest)) {
      const m = String(assigned).match(/_(\d+)\.[^.]+$/);
      if (m) nextIndex = Math.max(nextIndex, Number(m[1]));
    }

    let downloaded = 0;
    for (const item of media) {
      const key = mediaKey(item.url);

      // Already downloaded in a previous run?
      if (manifest[key] && fs.existsSync(path.join(outputDir, manifest[key]))) {
        downloaded++;
        onProgress({ found: media.length, downloaded });
        continue;
      }

      const ext = extFor(item.url, item.type);
      const candidate = `${profile}_${nextIndex + 1}.${ext}`;
      const dest = path.join(outputDir, candidate);

      try {
        const res = await context.request.get(item.url, { timeout: 60000 });
        if (res.ok()) {
          fs.writeFileSync(dest, await res.body());
          nextIndex += 1;
          manifest[key] = candidate;
          downloaded++;
          fs.writeFileSync(manifestPath, JSON.stringify(manifest));
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

module.exports = { backupProfile, extractMedia, filenameFor, ensureExt, mediaKey, extFor };
