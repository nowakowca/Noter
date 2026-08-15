# 📝 Noter

A simple, self-hosted note-taking / organization app. Add items to a list, each
with a **name**, a **hyperlink**, a **description**, and a **checkbox** to mark it
completed.

Runs as a single Docker container with a persistent SQLite database.

## Features

- Add, edit and delete items
- Each item has a name, optional hyperlink, optional description, and a completed checkbox
- Filter by **All / Active / Completed**
- **Instagram Backup** tab — back up a public profile's posts (photos, videos, carousels) to your machine
- Data persists across restarts via a Docker volume
- No external services — everything runs locally

## Instagram Backup

A second tab lets you back up the **posts** (photos, videos and carousels) from an
Instagram profile you're entitled to save — your own account or a public profile,
one at a time.

**How it works (hybrid approach):** a real Chromium browser (via
[Playwright](https://playwright.dev)) opens the profile and scrolls the wall.
As the page loads, Instagram's own JSON API responses are intercepted; those
contain the direct full-resolution image and `.mp4` video URLs, which are then
downloaded straight to disk. This gives browser-level realism *and* clean,
playable video files.

**Enter a profile** as a full link (`https://www.instagram.com/username/`) or a
bare username. Files are saved as `<username>_<N>.jpg` / `.mp4` in a per-profile
folder inside `MEDIA_DIR` (see [Configuration](#configuration)). Re-running a
backup keeps the existing numbering and only downloads new posts.

**Gallery:** each profile is a collapsible section. Tick the checkboxes on
individual items to **download** the selection (as a single `.zip`) or **delete**
them; use *Select all* to act on the whole profile at once.

**Optional login:** you can expand the *Login* section to supply your own
Instagram credentials (and a 2FA code) for more reliable / larger downloads. The
password is used only for that run — it is never logged or stored in plain text.
A session cookie is cached under `DATA_DIR/ig-sessions/` so you don't re-enter
it. Anonymous mode (no login) also works for public profiles — though Instagram
increasingly requires login to view profile media.

> **Please note**
> - Automated access is against Instagram's [Terms of Service](https://help.instagram.com/581066165581870); an account used for login can be flagged or banned.
> - Only back up content you have the right to save. Media remains the property of its posters.
> - This depends on Instagram's current site structure and can break when they change it.
> - Accounts protected by 2FA or a "suspicious login" security challenge may not be able to log in through the simple form; you'll get a clear error rather than a hang.
> - Captions are **not** downloaded — media files only.

## Item fields

| Field         | Required | Notes                                              |
| ------------- | -------- | -------------------------------------------------- |
| `name`        | yes      | The title of the item                              |
| `link`        | no       | A hyperlink; opens in a new tab                    |
| `description` | no       | Free-text details                                  |
| `completed`   | —        | Toggled via the checkbox                           |

## Quick start (Docker Compose)

```bash
docker compose up --build
```

Then open <http://localhost:3000>.

App state (notes database, saved login sessions) lives in the `noter-data`
volume. Backed-up **media** is written to `./backups` by default.

### Saving backups to a custom folder

Point the media at any host directory by setting `MEDIA_PATH` — either in a
`.env` file next to `docker-compose.yml` (copy `.env.example`) or inline:

```bash
MEDIA_PATH=/home/me/Pictures/instagram docker compose up --build
```

Backups then land in `/home/me/Pictures/instagram/<username>/`.

## Quick start (Docker)

```bash
docker build -t noter .
docker run -d --name noter -p 3000:3000 \
  -v noter-data:/app/data \
  -v /home/me/Pictures/instagram:/app/media \
  noter
```

## Running locally without Docker

Requires Node.js 18+.

```bash
npm install
# One-time: download the browser used by the Instagram backup feature
npx playwright install chromium
npm start
```

The app listens on <http://localhost:3000>. The SQLite database is created at
`./data/noter.db` (override the location with the `DATA_DIR` environment
variable).

## Configuration

| Variable        | Default                  | Description                                              |
| --------------- | ------------------------ | ------------------------------------------------------- |
| `PORT`          | `3000`                   | Port the HTTP server listens on                         |
| `DATA_DIR`      | `./data`                 | SQLite database and saved login sessions                |
| `MEDIA_DIR`     | `${DATA_DIR}/instagram`  | Where downloaded media is written (per-profile folders) |
| `PUID` / `PGID` | `1000` / `1000`          | Docker only: user/group that owns the DB and downloads  |
| `CHROMIUM_PATH` | *(Playwright default)*   | Override the Chromium binary used for backups           |
| `IG_SCROLL_DELAY`    | `2000`  | ms to wait between scrolls (raise on slow connections)     |
| `IG_SCROLL_PATIENCE` | `10`    | consecutive "no new media" rounds before stopping          |
| `IG_MAX_SCROLLS`     | `1500`  | hard cap on scroll iterations                              |

### Not all posts downloaded?

Posts are fetched primarily by paginating Instagram's own timeline API
(cursor-based), which walks every page deterministically — the status log shows
`Timeline API: fetched N page(s)`. If that API is unavailable, it falls back to
scrolling the page, which is less reliable (the `IG_SCROLL_*` knobs above tune
it).

The status log reports the profile's total post count and a final
`Discovered N of M posts` line. If it comes up short:

- A **carousel counts as one post but yields several media files**, so the media
  count can legitimately *exceed* the post count.
- If it fell back to scrolling and stopped early, raise `IG_SCROLL_PATIENCE`
  (e.g. `20`) and/or `IG_SCROLL_DELAY` (e.g. `3500`).
- Tagged posts and content Instagram hides from the timeline are not fetched.

### File ownership (Docker)

The container starts as root, fixes ownership of the data and media
directories, then drops to `PUID:PGID` (default `1000:1000`) before running.
So downloaded files are owned by that user — set `PUID`/`PGID` to your host
user (`id -u` / `id -g`) if it differs.

> In Docker, `MEDIA_DIR` is `/app/media` and is bind-mounted from the host
> `MEDIA_PATH` (default `./backups`). See
> [Saving backups to a custom folder](#saving-backups-to-a-custom-folder).

## API

The frontend talks to a small REST API:

| Method   | Path              | Description                          |
| -------- | ----------------- | ------------------------------------ |
| `GET`    | `/api/items`      | List all items                       |
| `POST`   | `/api/items`      | Create an item                       |
| `PUT`    | `/api/items/:id`  | Update an item                       |
| `PATCH`  | `/api/items/:id`  | Toggle / set the `completed` flag    |
| `DELETE` | `/api/items/:id`  | Delete an item                       |
| `POST`   | `/api/scrape`     | Start an Instagram backup            |
| `GET`    | `/api/scrape/status` | Progress of the running backup    |
| `GET`    | `/api/backups`    | List downloaded profiles and files   |
| `POST`   | `/api/backups/:profile/download` | Zip up selected files     |
| `POST`   | `/api/backups/:profile/delete`   | Delete selected files     |
| `GET`    | `/healthz`        | Health check                         |

## Tech stack

- **Backend:** Node.js + Express
- **Storage:** SQLite (via `better-sqlite3`); media on the filesystem
- **Instagram backup:** Playwright (headless Chromium)
- **Frontend:** vanilla HTML/CSS/JS (no build step)

> The Docker image is built on `node:20` and installs Chromium via
> `npx playwright install --with-deps chromium` at build time, so the browser
> always matches the `playwright` npm version. Both build stages share the same
> Node version so the native `better-sqlite3` binary loads at runtime.
