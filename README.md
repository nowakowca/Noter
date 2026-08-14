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
playable video files. Downloads land in `DATA_DIR/instagram/<profile>/` and are
browsable in a gallery.

**Optional login:** you can expand the *Login* section to supply your own
Instagram credentials (and a 2FA code) for more reliable / larger downloads. The
password is used only for that run — it is never logged or stored in plain text.
A session cookie is cached under `DATA_DIR/instagram/.sessions/` so you don't
re-enter it. Anonymous mode (no login) also works for public profiles.

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

Your notes are stored in the `noter-data` volume and survive restarts.

## Quick start (Docker)

```bash
docker build -t noter .
docker run -d --name noter -p 3000:3000 -v noter-data:/app/data noter
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
| `DATA_DIR`      | `./data`                 | Directory for the SQLite database and downloaded media  |
| `CHROMIUM_PATH` | *(Playwright default)*   | Override the Chromium binary used for backups           |

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
