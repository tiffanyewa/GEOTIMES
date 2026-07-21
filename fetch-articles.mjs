#!/usr/bin/env node
/**
 * Daily article updater for The New Geo Times.
 *
 * Pulls RECENT OPEN-ACCESS geophysics papers from OpenAlex, turns each into an
 * ORIGINAL news summary (via Claude, if a key is provided), and prepends them to
 * ../articles.json. Existing items are kept (newest-first ordering means older
 * stories naturally backfill the feed on slow days).
 *
 * Copyright note: we NEVER publish a paper's abstract. The abstract is only sent
 * to the model as background so it can write an original summary in its own words.
 * Without a model key, new items are saved as drafts (needsReview) that the app
 * hides until a human writes the summary.
 *
 * Env:
 *   OPENALEX_MAILTO    your email (OpenAlex "polite pool" — recommended)
 *   ANTHROPIC_API_KEY  optional; enables automatic original summaries
 *   CLAUDE_MODEL       optional; default "claude-3-5-haiku-latest"
 *   MAX_NEW            optional; max new articles per run (default 4)
 *   ARTICLE_CAP        optional; max total articles kept (default 60)
 */
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../articles.json", import.meta.url);
const MAILTO = process.env.OPENALEX_MAILTO || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = process.env.CLAUDE_MODEL || "claude-3-5-haiku-latest";
const MAX_NEW = Number(process.env.MAX_NEW || 4);
const CAP = Number(process.env.ARTICLE_CAP || 60);

const today = new Date().toISOString().slice(0, 10);
const fromDate = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

// Topic -> which section it maps to, plus the OpenAlex search terms.
// Tune these to match your editorial focus (NOSAR / SINTEF areas, etc.).
const TOPICS = [
  { cat: "Seismic",   kicker: "SEISMOLOGY",        terms: "seismology earthquake seismic array infrasound monitoring" },
  { cat: "Marine",    kicker: "MARINE GEOPHYSICS", terms: "marine geophysics ocean bottom seismometer distributed acoustic sensing seafloor" },
  { cat: "Tectonics", kicker: "TECTONICS",         terms: "crustal deformation plate tectonics glacial isostatic adjustment uplift" },
  { cat: "Energy",    kicker: "EXPLORATION",       terms: "CO2 storage monitoring full waveform inversion subsurface exploration geophysics" },
  { cat: "ML",        kicker: "AI & ML",           terms: "machine learning seismology deep learning geophysics neural network seismic" }
];

function reconstructAbstract(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, ps] of Object.entries(inv)) for (const p of ps) words[p] = w;
  return words.filter(Boolean).join(" ");
}
function slug(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
function fmtMeta(venue, dateISO) {
  const d = new Date(dateISO + "T00:00:00Z");
  return venue.toUpperCase() + " \u00b7 " + d.getUTCDate() + " " + MON[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

async function fetchTopic(t) {
  const url = "https://api.openalex.org/works?filter=open_access.is_oa:true,from_publication_date:" +
    fromDate + ",type:article&search=" + encodeURIComponent(t.terms) +
    "&sort=publication_date:desc&per-page=5" + (MAILTO ? "&mailto=" + encodeURIComponent(MAILTO) : "");
  const r = await fetch(url);
  if (!r.ok) { console.error("OpenAlex error", t.cat, r.status); return []; }
  const j = await r.json();
  return (j.results || []).map(w => ({
    t,
    doi: (w.doi || (w.ids && w.ids.doi) || "").replace(/^https?:\/\/doi\.org\//, ""),
    title: w.display_name || "",
    venue: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name)
        || (w.host_venue && w.host_venue.display_name) || "OpenAlex",
    oaUrl: (w.best_oa_location && w.best_oa_location.landing_page_url)
        || (w.primary_location && w.primary_location.landing_page_url) || w.doi || "",
    date: w.publication_date || today,
    authors: (w.authorships || []).slice(0, 3).map(a => a.author && a.author.display_name).filter(Boolean),
    abstract: reconstructAbstract(w.abstract_inverted_index)
  }));
}

async function summarize(p) {
  if (!ANTHROPIC_KEY) return null;
  const sys = "You are a science news editor for a geophysics publication. Write an ORIGINAL short news summary of a research paper for a science-literate general audience. Do NOT copy or closely paraphrase the abstract; synthesize the findings in your own words. Report findings as facts, avoid hype and cliches. Return STRICT JSON only (no markdown) with keys: lead (one sentence), body (array of 2-3 short paragraphs), quote (one vivid ORIGINAL sentence YOU write to capture the idea), quoteBy (a generic role like '\\u2014 Study author'; never invent a real person's name), tags (2-3 short strings).";
  const user = "TITLE: " + p.title + "\nVENUE: " + p.venue + "\nAUTHORS: " + p.authors.join(", ") +
    "\nABSTRACT (background for your understanding only \u2014 do not reproduce or quote): " + p.abstract.slice(0, 1500);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system: sys, messages: [{ role: "user", content: user }] })
  });
  if (!r.ok) { console.error("Anthropic error", r.status, (await r.text()).slice(0, 200)); return null; }
  const j = await r.json();
  const text = ((j.content && j.content[0] && j.content[0].text) || "").trim().replace(/^```json\s*|\s*```$/g, "");
  try { return JSON.parse(text); } catch (e) { console.error("Summary JSON parse failed:", text.slice(0, 160)); return null; }
}

async function main() {
  const data = JSON.parse(await readFile(OUT, "utf8"));
  const existing = data.articles || [];
  const seen = new Set(existing.flatMap(a => [a.id, a.doi].filter(Boolean)));

  const candidates = (await Promise.all(TOPICS.map(fetchTopic))).flat()
    .filter(p => p.title && p.oaUrl && p.doi && !seen.has(p.doi));

  const fresh = [];
  for (const p of candidates) {
    if (fresh.length >= MAX_NEW) break;
    const id = slug(p.doi || p.title);
    if (!id || seen.has(id)) continue;
    const s = await summarize(p);
    const base = {
      id, doi: p.doi, cat: p.t.cat, kicker: p.t.kicker, img: p.t.cat.toUpperCase(),
      title: p.title, source: p.venue, meta: fmtMeta(p.venue, today),
      byline: p.authors[0] ? ("By " + p.authors[0]) : "By The New Geo Times",
      metaLong: p.venue + " \u00b7 " + today, published: today,
      image: "", credit: "",
      sourceLabel: p.venue + " (open access)", sourceUrl: p.oaUrl
    };
    if (s) {
      Object.assign(base, { lead: s.lead, body: s.body || [], quote: s.quote || "", quoteBy: s.quoteBy || "\u2014 Study author", tail: [], tags: s.tags || [], status: "published" });
    } else {
      Object.assign(base, { lead: "Draft \u2014 needs an original summary before publishing.", body: [], quote: "", quoteBy: "", tail: [], tags: [], status: "draft", needsReview: true });
    }
    fresh.push(base);
    seen.add(id); seen.add(p.doi);
  }

  if (!fresh.length) { console.log("No new articles today; feed keeps previous items (backfill)."); return; }

  data.articles = [...fresh, ...existing].slice(0, CAP);
  data.generatedAt = new Date().toISOString();
  await writeFile(OUT, JSON.stringify(data, null, 2));
  console.log("Added " + fresh.length + " article(s). Drafts needing review: " + fresh.filter(a => a.needsReview).length + ".");
}

main().catch(e => { console.error(e); process.exit(1); });
