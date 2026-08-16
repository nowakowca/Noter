'use strict';

// Fetch the media for a single Instagram post / reel / tv link. Far more
// reliable than scraping a whole profile: one page load, no scrolling, no
// pagination. Returns the owner's username and the media URLs so the UI can
// preview them before saving.

const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const { extractMedia } = require('./instagram');

const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || undefined;
const BASE_URL = process.env.IG_BASE_URL || 'https://www.instagram.com';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Accept a full post/reel/tv URL or a bare shortcode.
function parseShortcode(input) {
  const s = String(input || '').trim();
  // The post code is the segment after /p/, /reel/, /reels/ or /tv/. We only
  // ever navigate to BASE_URL (instagram.com) with it, so the host is ignored.
  const m = s.match(/\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{5,}$/.test(s) && !s.includes('/') && !s.includes('.')) return s;
  return null;
}

// Instagram shortcodes are base64(mediaId). Convert back to the numeric id so we
// can hit the precise media-info endpoint.
function shortcodeToMediaId(shortcode) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let id = 0n;
  for (const ch of shortcode) {
    const v = A.indexOf(ch);
    if (v < 0) return null;
    id = id * 64n + BigInt(v);
  }
  return id.toString();
}

function sanitizeUser(name) {
  return (
    String(name || '')
      .trim()
      .replace(/^@/, '')
      .replace(/[^a-zA-Z0-9._]/g, '')
      .toLowerCase() || 'unknown'
  );
}

// Find the first plausible owner username in an arbitrary JSON tree.
function findUsername(node) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (typeof n.username === 'string' && n.username) {
      found = n.username;
      return;
    }
    for (const k of Object.keys(n)) walk(n[k]);
  })(node);
  return found;
}

async function fetchPostMedia({ url, creds, sessionDir, onLog = () => {} }) {
  const shortcode = parseShortcode(url);
  if (!shortcode) {
    throw new Error("That doesn't look like an Instagram post, reel or tv link.");
  }
  const mediaId = shortcodeToMediaId(shortcode);

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const contextOpts = { userAgent: UA, viewport: { width: 1280, height: 900 } };
    const sessionFile = creds ? path.join(sessionDir, `${creds.user}.json`) : null;
    if (sessionFile && fs.existsSync(sessionFile)) {
      contextOpts.storageState = sessionFile;
      onLog('Using saved session.');
    }
    const context = await browser.newContext(contextOpts);
    const page = await context.newPage();

    const media = [];
    const seen = new Set();
    let username = null;

    // Capture media/owner from any JSON the page loads.
    page.on('response', async (r) => {
      try {
        const ct = (r.headers()['content-type'] || '').toLowerCase();
        if (!ct.includes('json')) return;
        const j = await r.json().catch(() => null);
        if (!j) return;
        extractMedia(j, media, seen);
        if (!username) username = findUsername(j);
      } catch (_) {
        /* ignore */
      }
    });

    onLog(`Opening ${shortcode}…`);
    await page.goto(`${BASE_URL}/p/${encodeURIComponent(shortcode)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(2500);

    // Precise path: the media-info endpoint returns exactly this post's media
    // (images, video_versions, carousel children) plus the owner.
    if (mediaId) {
      const info = await page
        .evaluate(async (id) => {
          try {
            const res = await fetch(`/api/v1/media/${id}/info/`, {
              headers: { 'X-IG-App-ID': '936619743392459' },
              credentials: 'include',
            });
            if (!res.ok) return { ok: false, status: res.status };
            return { ok: true, json: await res.json() };
          } catch (e) {
            return { ok: false, status: 0 };
          }
        }, mediaId)
        .catch(() => ({ ok: false }));

      if (info.ok && info.json) {
        extractMedia(info.json, media, seen);
        try {
          username = info.json.items[0].user.username || username;
        } catch (_) {
          /* keep existing */
        }
      } else {
        onLog(`media-info endpoint: HTTP ${info.status || 'error'} (using page data).`);
      }
    }

    // Fallback: Open Graph meta tags (work for many public posts without login).
    if (!media.length) {
      const og = await page
        .evaluate(() => ({
          image: document.querySelector('meta[property="og:image"]')?.content || null,
          video: document.querySelector('meta[property="og:video"]')?.content || null,
          title: document.querySelector('meta[property="og:title"]')?.content || null,
        }))
        .catch(() => ({}));
      if (og.video) media.push({ type: 'video', url: og.video });
      else if (og.image) media.push({ type: 'image', url: og.image });
      if (!username && og.title) {
        const m = og.title.match(/\(@([A-Za-z0-9._]+)\)/) || og.title.match(/^([A-Za-z0-9._]+)/);
        if (m) username = m[1];
      }
    }

    if (!media.length) {
      // Detect a login wall for a clearer message.
      const needLogin = await page
        .locator('input[name="password"]')
        .count()
        .catch(() => 0);
      throw new Error(
        needLogin
          ? 'Instagram wants a login to view this post. Add your login and try again.'
          : 'Could not find media for that link (the post may be private or removed).'
      );
    }

    return { username: sanitizeUser(username), shortcode, media };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchPostMedia, parseShortcode, shortcodeToMediaId, sanitizeUser };
