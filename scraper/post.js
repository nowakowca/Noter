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

// Classify a link: a post/reel, a whole story highlight, or a single story.
function parseLink(input) {
  const s = String(input || '').trim();
  let m;

  // Instagram share short-links: /s/<base64>?... . The base64 decodes to
  // something like "highlight:1786..." (the target of the share).
  if ((m = s.match(/\/s\/([A-Za-z0-9_-]+)/i))) {
    let decoded = '';
    try {
      decoded = Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch (_) {
      /* not base64 */
    }
    const hm = decoded.match(/highlight:(\d+)/i);
    if (hm) return { kind: 'highlight', id: hm[1] };
    const scm = decoded.match(/(?:^|\/)(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i);
    if (scm) return { kind: 'post', shortcode: scm[1] };
  }

  if ((m = s.match(/\/stories\/highlights\/(\d+)/i))) {
    return { kind: 'highlight', id: m[1] };
  }
  if ((m = s.match(/\/stories\/([A-Za-z0-9._]+)\/(\d+)/i))) {
    return { kind: 'story', username: m[1], id: m[2] };
  }
  const shortcode = parseShortcode(s);
  if (shortcode) return { kind: 'post', shortcode };
  return null;
}

// Fetch JSON from inside the authenticated page, returning the HTTP status.
async function apiFetchInPage(page, url) {
  return page
    .evaluate(async (u) => {
      try {
        const res = await fetch(u, {
          headers: { 'X-IG-App-ID': '936619743392459' },
          credentials: 'include',
        });
        let json = null;
        try {
          json = await res.json();
        } catch (_) {
          /* not JSON */
        }
        return { ok: res.ok, status: res.status, json };
      } catch (e) {
        return { ok: false, status: 0, json: null };
      }
    }, url)
    .catch(() => ({ ok: false, status: -1, json: null }));
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
  const link = parseLink(url);
  if (!link) {
    throw new Error(
      "That doesn't look like an Instagram post, reel, tv or highlight link."
    );
  }

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

    if (link.kind === 'post') {
      await fetchPost(page, link.shortcode, media, seen, notes, (u) => {
        if (u) username = u;
      }, onLog);
    } else if (link.kind === 'highlight') {
      username = await fetchHighlight(page, link.id, media, seen, notes, onLog);
    } else if (link.kind === 'story') {
      username = await fetchStory(page, link, media, seen, notes, onLog);
    }

    if (!media.length) {
      const needLogin = await page
        .locator('input[name="password"]')
        .count()
        .catch(() => 0);
      const isAuthKind = link.kind === 'highlight' || link.kind === 'story';
      throw new Error(
        needLogin || isAuthKind
          ? 'Could not read that — highlights and stories require a login. Add your Instagram login and try again.'
          : 'Could not find media for that link (it may be private or removed).'
      );
    }

    onLog(notes.join(' · '));
    return {
      username: sanitizeUser(username),
      ref: link.shortcode || link.id,
      media,
      notes,
    };
  } finally {
    await browser.close().catch(() => {});
  }
}

// A post / reel / tv: embedded page JSON first (no login, full carousel), then
// the media-info endpoint, then Open Graph as a last resort.
async function fetchPost(page, shortcode, media, seen, notes, setUser, onLog) {
  const mediaId = shortcodeToMediaId(shortcode);
  onLog(`Opening ${shortcode}…`);
  await page.goto(`${BASE_URL}/p/${encodeURIComponent(shortcode)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await sleep(2500);

  const emb = await harvestEmbeddedPost(page, shortcode, media, seen);
  if (emb.username) setUser(emb.username);
  notes.push(
    emb.matched ? `embedded post data: ${media.length} media` : 'embedded post data: not found'
  );

  if (mediaId) {
    const info = await apiFetchInPage(page, `/api/v1/media/${mediaId}/info/`);
    if (info.ok && info.json) {
      const before = media.length;
      extractMedia(info.json, media, seen);
      try {
        setUser(info.json.items[0].user.username);
      } catch (_) {
        /* keep existing */
      }
      notes.push(`media-info: OK (+${media.length - before} media)`);
    } else {
      notes.push(`media-info: HTTP ${info.status || 'error'}`);
    }
  }

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
    if (og.title) {
      const m = og.title.match(/\(@([A-Za-z0-9._]+)\)/) || og.title.match(/^([A-Za-z0-9._]+)/);
      if (m) setUser(m[1]);
    }
    if (media.length) notes.push('fell back to Open Graph (first image only)');
  }
}

// A whole story highlight: reels_media returns every story item in the reel.
async function fetchHighlight(page, highlightId, media, seen, notes, onLog) {
  onLog(`Opening highlight ${highlightId}…`);
  await page.goto(`${BASE_URL}/stories/highlights/${encodeURIComponent(highlightId)}/`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await sleep(2500);

  const reelId = `highlight:${highlightId}`;
  const res = await apiFetchInPage(
    page,
    `/api/v1/feed/reels_media/?reel_ids=${encodeURIComponent(reelId)}`
  );
  notes.push(`reels_media: HTTP ${res.status}`);
  const reel = res.json && res.json.reels ? res.json.reels[reelId] : null;
  const items = reel && Array.isArray(reel.items) ? reel.items : [];
  for (const item of items) extractMedia(item, media, seen);
  notes.push(`highlight: ${media.length} media`);
  return reel ? usernameOf(reel) || (items[0] && usernameOf(items[0])) : null;
}

// A single story item: the id in the URL is the media pk.
async function fetchStory(page, link, media, seen, notes, onLog) {
  onLog(`Opening story ${link.id}…`);
  await page.goto(
    `${BASE_URL}/stories/${encodeURIComponent(link.username)}/${encodeURIComponent(link.id)}/`,
    { waitUntil: 'domcontentloaded', timeout: 60000 }
  );
  await sleep(2500);

  const res = await apiFetchInPage(page, `/api/v1/media/${link.id}/info/`);
  notes.push(`media-info: HTTP ${res.status}`);
  let username = link.username;
  if (res.json) {
    extractMedia(res.json, media, seen);
    try {
      username = res.json.items[0].user.username || username;
    } catch (_) {
      /* keep */
    }
  }
  return username;
}

module.exports = { fetchPostMedia, parseShortcode, shortcodeToMediaId, sanitizeUser };
