// The Catch-Up News Desk — news API (Vercel serverless function)
// Needs one environment variable in Vercel: ANTHROPIC_API_KEY
// Optional: CLAUDE_MODEL (default below), ALLOWED_DOMAINS (comma list, e.g. nusparklearnwow.com,nusparkpublishing.com)

const DEFAULT_MODEL = 'claude-sonnet-5-5';

const LEVELS = ['World', 'Country', 'State / Region', 'County', 'City'];
const TIMES = { '24h': 'the last 24 hours', '48h': 'the last 48 hours', '7d': 'the last 7 days' };
const HOURS = { '24h': 24, '48h': 48, '7d': 168 };
// How long a finished result is saved and shared with every visitor (seconds)
const CACHE_SECONDS = { '24h': 10800, '48h': 21600, '7d': 86400 };
const CATS = [
  'General Highlights', 'Politics & Government', 'Business & Money', 'Tech & AI',
  'Science & Health', 'Sports', 'Entertainment & Culture', 'Wow...Who Knew?', 'Weather & Local Alerts'
];

function allowed(req) {
  const list = (process.env.ALLOWED_DOMAINS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return true; // not set yet = open (testing)
  const host = (req.headers.host || '').toLowerCase();
  const ref = req.headers.origin || req.headers.referer || '';
  let refHost = '';
  try { refHost = new URL(ref).hostname.toLowerCase(); } catch (e) { return false; }
  if (refHost === host.split(':')[0]) return true;
  return list.some(d => refHost === d || refHost.endsWith('.' + d));
}

// Per-visitor limit: news searches per hour (results everyone shares from the cache don't count)
const HOURLY_LIMIT = 20;
const hits = new Map();
function overLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'x';
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  if (list.length >= HOURLY_LIMIT) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 20000) hits.clear();
  return false;
}

function buildPrompt(level, place, time, cat) {
  const now = new Date();
  const since = new Date(now.getTime() - HOURS[time] * 3600 * 1000);
  const where = level === 'World' ? 'the whole world (major global stories)' : `${place} (${level.toLowerCase()} level)`;
  const count = cat === 'General Highlights' ? '5 to 7' : '4 to 6';
  return `Today is ${now.toUTCString()}. Find the most important news for ${where}, in the section "${cat}", published in ${TIMES[time]} (since ${since.toUTCString()}).

Search the web for current coverage from several reputable outlets, then write ${count} stories.

RULES
- Only stories from the time window. Only confirmed facts. If outlets disagree or details are unconfirmed, say "reports say" or "officials say".
- Write everything in your own words, combining several outlets. Never copy sentences from an article, including in "latest". No quotes longer than a few words.
- Plain text only in every field: no citation tags, no <cite> markers, no HTML, no markdown. Put source details only in "sources".
- Pick the card type per story:
  - "quick" = breaking news, incidents and events (a fire, a strike, an accident, a storm, a single announcement). Give "summary" (one short paragraph, 2-3 sentences) and "latest" (the newest confirmed detail with the time reported). No paragraphs.
  - "full" = bigger stories with real context (decisions, policies, trends, business, science breakthroughs). Give "paragraphs": at least 2, and as many more as the story needs to tell a regular person what they need to know: what happened, why it matters to everyday people, what comes next. No padding, no filler. Optionally "background": a short catch-up for people who missed earlier parts.
- Set "developing": true while a story is still unfolding.
- Politics and contested topics: strictly neutral. No opinions, no loaded words, never say who is right. For political stories include "coverage" describing, in one sentence each, how left-leaning, center and right-leaning outlets are framing the story. If you can't find a side's coverage, write "Limited coverage found."
- "Wow...Who Knew?" = surprising, odd, delightful or feel-good stories. "Weather & Local Alerts" = forecasts, warnings, closures, safety alerts.
- If the place is small and there is too little news in the window, widen one level (city to county, county to state, state to country) and explain in "scope_note", e.g. "Not much in the last 24 hours for Doylestown, so here's Bucks County." If the place name is ambiguous, choose the best-known one and mention it in "scope_note". Otherwise "scope_note" is "".
- "updated" = when the latest report came out, short form like "Nov 18, 6:10 AM ET".
- 2 to 4 "sources" per story, each with the outlet name and the article URL you actually found.

Reply with ONLY this JSON, nothing before or after:
{"scope_note":"","stories":[{"kind":"quick","developing":false,"headline":"","updated":"","summary":"","latest":"","paragraphs":[],"background":"","coverage":null,"sources":[{"name":"","url":""}]}]}
For "coverage" on political stories use {"left":"","center":"","right":""}.`;
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('no json');
  return JSON.parse(text.slice(start, end + 1));
}

// Removes citation markers and any stray HTML the search step can leave behind
function plain(v) {
  return String(v || '')
    .replace(/<\/?cite[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function clean(data) {
  const okUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u);
  const stories = (Array.isArray(data.stories) ? data.stories : []).slice(0, 10).map(s => ({
    kind: s.kind === 'full' ? 'full' : 'quick',
    developing: !!s.developing,
    headline: plain(s.headline).slice(0, 300),
    updated: plain(s.updated).slice(0, 60),
    summary: plain(s.summary),
    latest: plain(s.latest),
    paragraphs: (Array.isArray(s.paragraphs) ? s.paragraphs : []).map(plain).filter(Boolean),
    background: plain(s.background),
    coverage: s.coverage && typeof s.coverage === 'object'
      ? { left: plain(s.coverage.left), center: plain(s.coverage.center), right: plain(s.coverage.right) }
      : null,
    sources: (Array.isArray(s.sources) ? s.sources : []).filter(x => x && okUrl(x.url))
      .slice(0, 4).map(x => ({ name: (plain(x.name) || 'Source').slice(0, 80), url: x.url }))
  })).filter(s => s.headline);
  return { scope_note: plain(data.scope_note), stories };
}

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (req.method !== 'GET') { res.status(405).end(JSON.stringify({ error: 'Use GET' })); return; }
  if (!allowed(req)) { res.status(403).end(JSON.stringify({ error: 'This tool only runs on NuSpark sites.' })); return; }

  const q = req.query || {};
  const level = LEVELS.includes(q.level) ? q.level : 'World';
  const time = TIMES[q.time] ? q.time : '24h';
  const cat = CATS.includes(q.cat) ? q.cat : 'General Highlights';
  const place = String(q.place || '').trim().slice(0, 80);
  if (level !== 'World' && !place) { res.status(400).end(JSON.stringify({ error: 'Please type a place.' })); return; }

  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).end(JSON.stringify({ error: 'Missing API key.' })); return; }

  if (overLimit(req)) { res.status(429).end(JSON.stringify({ error: "You've caught up on a lot of news this hour! Please try again in a little while." })); return; }

  try {
    const call = messages => fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || DEFAULT_MODEL,
        max_tokens: 8000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
        messages
      })
    });
    const messages = [{ role: 'user', content: buildPrompt(level, place, time, cat) }];
    let text = '';
    for (let round = 0; round < 4; round++) {
      const r = await call(messages);
      const body = await r.json();
      if (!r.ok) {
        console.error('Anthropic error', r.status, JSON.stringify(body).slice(0, 500));
        res.status(502).end(JSON.stringify({ error: 'The newsroom is busy. Please try again in a minute.' }));
        return;
      }
      text += (body.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
      // Long searches can pause partway ("pause_turn"): let the AI keep going so the stories aren't lost
      if (body.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: body.content }); continue; }
      // Finished searching but forgot the stories: ask for just the finished answer
      if (!extractJson(text) && round === 0) {
        messages.push({ role: 'assistant', content: body.content });
        messages.push({ role: 'user', content: 'Thank you. Now reply with ONLY the finished JSON in the exact format requested, using the coverage you already found. Do not search again.' });
        continue;
      }
      break;
    }
    const data = clean(extractJson(text));
    if (!data.stories.length) {
      res.status(200).end(JSON.stringify({ scope_note: data.scope_note || 'No stories found for that place and time. Try a wider area or a longer time window.', stories: [] }));
      return;
    }
    // Save the finished result at Vercel's edge so every visitor asking the same thing shares it
    res.setHeader('Cache-Control', `public, s-maxage=${CACHE_SECONDS[time]}, stale-while-revalidate=3600`);
    res.status(200).end(JSON.stringify(data));
  } catch (e) {
    console.error(e);
    res.status(500).end(JSON.stringify({ error: 'Something went wrong pulling the news. Please try again.' }));
  }
};
