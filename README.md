# Daily article updater

Keeps `articles.json` fresh so the app's news feed updates every day. Quakes are
already live (USGS + EMSC, fetched in the browser); this handles the written
articles.

## What it does

`fetch-articles.mjs` runs once a day (via GitHub Actions) and:

1. Queries **OpenAlex** for recent **open-access** geophysics papers across your
   topic areas (seismology, marine, tectonics, energy/CO₂, AI & ML).
2. For each new paper, writes an **original** news summary — in its own words —
   using Claude (if `ANTHROPIC_API_KEY` is set), plus a link to the open-access
   source.
3. Prepends the new items to `articles.json`. Nothing is deleted (up to a cap), so
   on quiet days the previous articles stay and **backfill** the feed.

The app reads `articles.json`, shows everything newest-first, and **hides drafts**
(`needsReview`/`status:"draft"`) until a human has written/approved them.

## Copyright

The script **never publishes a paper's abstract**. Abstracts are only sent to the
model as background so it can write an original summary. Only open-access papers
are pulled, and each item links back to its source. Keep a human in the loop on
anything auto-generated before it goes public.

## Setup (GitHub)

1. Put this project in a GitHub repo (must include `articles.json`, `tools/`, and
   `.github/workflows/`).
2. **Settings → Secrets and variables → Actions** → add:
   - `ANTHROPIC_API_KEY` — optional but recommended (enables auto-summaries).
     Without it, new items are saved as drafts for you to write.
   - `OPENALEX_MAILTO` — your email (OpenAlex "polite pool"; recommended).
3. **Settings → Actions → General → Workflow permissions** → "Read and write".
4. Trigger it once from the **Actions** tab (**Daily articles → Run workflow**) to
   test, then it runs daily at 05:00 UTC.

## Run locally

```bash
export ANTHROPIC_API_KEY=sk-ant-...      # optional
export OPENALEX_MAILTO=you@example.com   # optional
node tools/fetch-articles.mjs
```

## Tuning

- **Topics / search terms:** edit the `TOPICS` array in `fetch-articles.mjs`.
- **How many new per day:** `MAX_NEW` (default 4).
- **How many kept total:** `ARTICLE_CAP` (default 60).
- **Model:** `CLAUDE_MODEL` (default `claude-3-5-haiku-latest`).
- **Schedule:** the `cron` line in `.github/workflows/daily-articles.yml`.

## Fields the app expects per article

`id, cat (Seismic|Marine|Tectonics|Energy|ML), kicker, img, title, source, meta,
byline, metaLong, published (YYYY-MM-DD), lead, body[], quote, quoteBy, tail[],
tags[], image, credit, sourceLabel, sourceUrl`. Auto-generated items also carry
`doi` and `status`.

## Where the app fetches from

The app loads `./articles.json` (same origin). When you host it, make sure that
file is served next to the app. For the quake APIs, consider a small proxy/cache
in production to avoid CORS/rate-limit surprises.
