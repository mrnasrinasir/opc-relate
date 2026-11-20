# Relate

A relationship workspace for one-person companies, built for the OPC hackathon.

You meet someone, capture them in a few steps (LinkedIn URL, their name, a QR code or a business card), and Relate builds their profile card with cited research from Exa. From there it drafts a **Talk Track** for your next conversation (topics and discovery questions) and a follow-up email and LinkedIn message. You send everything yourself; Relate never posts or messages on your behalf.

## Features

- **Capture profile:** a guided wizard. Paste a LinkedIn URL or type a name, and Exa finds the profile and returns a structured card (headline, role, company, about, photo).
- **Cited research:** a few highlights about the person, each tied to a page Exa cited. Anything without a matching citation is marked *gap flagged*.
- **Talk Track:** three or four topics with open questions about their world, plus a shareable page where they can mark "start here".
- **Next steps:** a draft follow-up email and LinkedIn message, ready to edit and send.
- **Voice notes:** recorded in the browser and transcribed by the QwenWork agent.
- **Business card OCR:** card photos are queued for the QwenWork agent to read.

## How it's built

| Part | What it is |
|---|---|
| `server.js` | Plain Node 22 `http` server with no dependencies: the API, the login, and the public share pages |
| `index.html` | The whole single-page app (vanilla JS) |
| Supabase | Postgres via the REST API. Tables are in [`schema.sql`](schema.sql) |
| Exa | `/search` and `/answer` for profile cards, research, talk tracks and drafts. The key is stored in Settings |
| QwenWork agent | Works through the queued jobs (OCR, transcription, research, profile pulls) and writes results back through the API |

## Run it

1. Create a Supabase project and run [`schema.sql`](schema.sql) in its SQL editor.
2. Copy `.env.example` to `.env` and fill in `SUPABASE_URL`, `SUPABASE_ANON_KEY` and a long random `APP_TOKEN`.
3. Start the server (Node 22 or newer):

   ```bash
   node --env-file=.env server.js
   ```

4. Open http://localhost:8081, sign in with your `APP_TOKEN`, then add your Exa key in **Settings**.

## Access

The workspace is private to you.

- **Browser:** sign in at `/login` with `APP_TOKEN`. This sets an HttpOnly session cookie for 30 days. Sign out at `/logout`.
- **QwenWork agent:** send `Authorization: Bearer <APP_TOKEN>` with every API call.
- **Recipients:** shared links work without signing in, but only for these routes:
  - `GET /talk/:id`, plus `PATCH /api/talk/:id/pick` so they can pick a topic
  - `GET /deck/:id`, plus `POST /api/deck/:id/accept` and `GET /api/deck/:id/pdf`
  - `GET /share/:id`

If `APP_TOKEN` isn't set, the server refuses all private routes. Nothing falls back to being open.

## Agent API

The QwenWork agent polls each queue and writes back with `PUT`:

| Queue | Poll | Fetch input | Write back |
|---|---|---|---|
| Research | `GET /api/research` | (in the job) | `PUT /api/research/:id` with `{ findings, assessment }` |
| Profile pull | `GET /api/profilecard` | (in the job) | `PUT /api/profilecard/:id` with `{ card }` |
| Business card | `GET /api/ocr` | `GET /api/ocr/:id/image` | `PUT /api/ocr/:id` with `{ fields }` |
| Transcription | `GET /api/transcribe` | `GET /api/transcribe/:id/audio` | `PUT /api/transcribe/:id` with `{ text }` |

All of these need the bearer token.
