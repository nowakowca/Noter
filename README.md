# 📝 Noter

A simple, self-hosted note-taking / organization app. Add items to a list, each
with a **name**, a **hyperlink**, a **description**, and a **checkbox** to mark it
completed.

Runs as a single Docker container with a persistent SQLite database.

## Features

- Add, edit and delete items
- Each item has a name, optional hyperlink, optional description, and a completed checkbox
- Filter by **All / Active / Completed**
- Data persists across restarts via a Docker volume
- No external services — everything runs locally

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
npm start
```

The app listens on <http://localhost:3000>. The SQLite database is created at
`./data/noter.db` (override the location with the `DATA_DIR` environment
variable).

## Configuration

| Variable   | Default      | Description                          |
| ---------- | ------------ | ------------------------------------ |
| `PORT`     | `3000`       | Port the HTTP server listens on      |
| `DATA_DIR` | `./data`     | Directory for the SQLite database    |

## API

The frontend talks to a small REST API:

| Method   | Path              | Description                          |
| -------- | ----------------- | ------------------------------------ |
| `GET`    | `/api/items`      | List all items                       |
| `POST`   | `/api/items`      | Create an item                       |
| `PUT`    | `/api/items/:id`  | Update an item                       |
| `PATCH`  | `/api/items/:id`  | Toggle / set the `completed` flag    |
| `DELETE` | `/api/items/:id`  | Delete an item                       |
| `GET`    | `/healthz`        | Health check                         |

## Tech stack

- **Backend:** Node.js + Express
- **Storage:** SQLite (via `better-sqlite3`)
- **Frontend:** vanilla HTML/CSS/JS (no build step)
