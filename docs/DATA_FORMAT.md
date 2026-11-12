# Data format

All data lives in `data/` (or `$TWEETMGR_DATA`). Files are pretty-printed JSON and safe to edit by hand, by scripts, or by AI agents. Write a whole file at once; the app re-reads it when its tab regains focus.

## Thread: `data/threads/<id>.json`

```json
{
  "id": "th_0b6c3f0e-...",
  "profileId": "p_5a1d...",
  "title": "Why do cells age?",
  "schemaVersion": 1,
  "createdAt": "2026-11-12T01:00:00.000Z",
  "updatedAt": "2026-11-12T01:05:00.000Z",
  "tweets": [
    {
      "id": "t_1",
      "text": "Why do our cells age? 🧵",
      "media": [
        { "id": "m_1", "source": "upload", "imageId": "img_3f9a1c2b7d4e.png", "alt": "Telomere length by age" },
        { "id": "m_2", "source": "url", "url": "https://example.com/figure.png", "alt": "Hayflick's original figure" }
      ]
    }
  ]
}
```

- `id` must match the file name and contain only letters, digits, `_`, `-`, `.`.
- Bump `updatedAt` (ISO 8601) when you change a file so the app notices.
- `tweets` is in posting order. Up to 4 `media` items per tweet; `alt` up to 1,000 characters.
- Media `source`:
  - `upload`: `imageId` is a file name inside `data/images/`. To attach a figure, copy it into `data/images/` and reference its file name.
  - `url`: a remote image; only the URL is stored.

## Profile: `data/profiles/<id>.json`

```json
{ "id": "p_5a1d...", "name": "Your Name", "handle": "yourhandle", "accountType": "free", "customLimit": 280 }
```

`accountType` is `free` (280), `premium` (25,000), or `custom` (uses `customLimit`).

## HTTP API

The local server (`npm start`) exposes the same data at `http://localhost:4321/api/...`; see the header of `server.js` for routes.
