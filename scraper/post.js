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

// Find the specific post object in an arbitrary JSON tree by its shortcode, so
// we extract only THIS post's media (and owner) — not unrelated media that may
// also be embedded on the page.
function findPostNode(node, shortcode) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const c of n) walk(c);
      return;
    }
    if (n.code === shortcode || n.shortcode === shortcode) {
      found = n;
      return;
    }
    for (const k of Object.keys(n)) walk(n[k]);
  })(node);
  return found;
}

function usernameOf(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.owner && typeof node.owner.username === 'string') return node.owner.username;
  if (node.user && typeof node.user.username === 'string') return node.user.username;
  return findUsername(node);
}

// Parse the post's own JSON embedded in the page HTML (<script
// type="application/json"> blocks). Returns { media added, username } for the
// post matching `shortcode`. Works for public posts without logging in.
async function harvestEmbeddedPost(page, shortcode, media, seen) {
  const blobs = await page
    .$$eval('script[type="application/json"]', (els) => els.map((e) => e.textContent))
    .catch(() => []);
  let username = null;
  let matched = false;
  for (const blob of blobs) {
    let json;
    try {
      json = JSON.parse(blob);
    } catch (_) {
      continue;
    }
    const node = findPostNode(json, shortcode);
    if (node) {
      matched = true;
      extractMedia(node, media, seen);
      if (!username) username = usernameOf(node);
    }
  }
  return { matched, username };
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
    const notes = [];

    onLog(`Opening ${shortcode}…`);
    await page.goto(`${BASE_URL}/p/${encodeURIComponent(shortcode)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await sleep(2500);

    // 1) Precise, no-login: the post's own JSON embedded in the page HTML.
    const emb = await harvestEmbeddedPost(page, shortcode, media, seen);
    if (emb.username) username = emb.username;
    notes.push(
      emb.matched
        ? `embedded post data: ${media.length} media`
        : 'embedded post data: not found'
    );

    // 2) media-info endpoint (needs a valid login) — fills carousels/video the
    //    embedded data might lack, and the owner if still unknown.
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
        const before = media.length;
        extractMedia(info.json, media, seen);
        try {
          username = info.json.items[0].user.username || username;
        } catch (_) {
          /* keep existing */
        }
        notes.push(`media-info: OK (+${media.length - before} media)`);
      } else {
        notes.push(`media-info: HTTP ${info.status || 'error'}`);
      }
    }

    // 3) Last resort: Open Graph (only the first, cropped image — flag it).
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
      if (media.length) notes.push('fell back to Open Graph (first image only)');
    }

    if (!media.length) {
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

    onLog(notes.join(' · '));
    return { username: sanitizeUser(username), shortcode, media, notes };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { fetchPostMedia, parseShortcode, shortcodeToMediaId, sanitizeUser };
