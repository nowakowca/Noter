# 📝 Noter

A simple, self-hosted note-taking / organization app. Add items to a list, each
with a **name**, a **hyperlink**, a **description**, and a **checkbox** to mark it
completed.

Runs as a single Docker container with a persistent SQLite database.

## Features

- Add, edit and delete items
- Each item has a name, optional hyperlink, optional description, and a completed checkbox
- Filter by **All / Active / Completed**
- **Instagram** tab — save the media from a single post / reel by pasting its link
- Data persists across restarts via a Docker volume
- No external services — everything runs locally

## Instagram (save a post by link)

A second tab lets you save the media (photo, video, or every image in a carousel)
from a single Instagram **post / reel** you're entitled to save.

**How it works:** paste a post link, and a real Chromium browser (via
[Playwright](https://playwright.dev)) opens it and reads that post's media via
Instagram's own media-info endpoint (with an Open Graph fallback). The media is
**previewed full-size** so you can check it, then **Save all** downloads it to
disk. One post at a time — no profile scraping, no scrolling, no pagination, so
it's far more robust.

**Files** are saved as `<username>_<N>.jpg` / `.mp4` in a per-user folder inside
`MEDIA_DIR` (see [Configuration](#configuration)); saving the same media twice is
de-duplicated.

**Saved-media gallery:** each user is a collapsible section. Tick the checkboxes
to **download** a selection (as a single `.zip`) or **delete** it; use *Select
all* to act on the whole user at once.

**Optional login:** expand the *Login* section to supply your own Instagram
credentials (and a 2FA code) for private posts or when Instagram asks. The
password is used only for that run — never logged or stored in plain text — and a
session cookie is cached under `DATA_DIR/ig-sessions/`. Many public posts work
without login.

> **Please note**
> - Automated access is against Instagram's [Terms of Service](https://help.instagram.com/581066165581870); an account used for login can be flagged or banned.
> - Only save content you have the right to save. Media remains the property of its posters.
> - This depends on Instagram's current site and can break if they change it.
> - Captions are **not** saved — media files only.

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
| `CHROMIUM_PATH` | *(Playwright default)*   | Override the Chromium binary used for fetching posts    |

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
| `POST`   | `/api/ig/fetch`   | Read a post's media (for preview)    |
| `POST`   | `/api/ig/save`    | Download selected media to disk      |
| `GET`    | `/api/backups`    | List saved users and their files     |
| `POST`   | `/api/backups/:profile/download` | Zip up selected files     |
| `POST`   | `/api/backups/:profile/delete`   | Delete selected files     |
| `GET`    | `/healthz`        | Health check                         |

## Tech stack

- **Backend:** Node.js + Express
- **Storage:** SQLite (via `better-sqlite3`); media on the filesystem
- **Instagram:** Playwright (headless Chromium)
- **Frontend:** vanilla HTML/CSS/JS (no build step)

> The Docker image is built on `node:20` and installs Chromium via
> `npx playwright install --with-deps chromium` at build time, so the browser
> always matches the `playwright` npm version. Both build stages share the same
> Node version so the native `better-sqlite3` binary loads at runtime.
