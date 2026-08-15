const express = require('express');
const { v4: uuidv4 } = require('uuid');
const Anthropic = require('@anthropic-ai/sdk').default;
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const runs = new Map();

const COUNTRY_MAP = {
  SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia',
  TH: 'Thailand', PH: 'Philippines', VN: 'Vietnam',
  AU: 'Australia', GB: 'United Kingdom', US: 'United States',
  IN: 'India', JP: 'Japan', KR: 'South Korea',
  HK: 'Hong Kong', TW: 'Taiwan'
};

const COUNTRY_NOISE = {
  SG: ['philippines','pilipinas',' ph ','pinas','manila','cebu','davao','malaysia','indonesia','jakarta','thailand','bangkok','vietnam','india','australia','uk ','united kingdom','united states',' usa ','canada'],
  MY: ['philippines','pilipinas','singapore','indonesia','jakarta','thailand','vietnam'],
  ID: ['philippines','singapore','malaysia','thailand','vietnam'],
  TH: ['philippines','singapore','malaysia','indonesia','vietnam'],
  PH: ['singapore','malaysia','indonesia','thailand','vietnam'],
  AU: ['philippines','singapore','malaysia','indonesia','india'],
  GB: ['philippines','singapore','malaysia','indonesia','india'],
  US: ['philippines','singapore','malaysia','indonesia'],
};

function geoScore(items, countryCode, textFn, subredditFn) {
  const countryName = (COUNTRY_MAP[countryCode] || '').toLowerCase();
  const noiseTerms = COUNTRY_NOISE[countryCode] || [];

  const scored = items.map(item => {
    let score = 0;
    const text = (textFn(item) || '').toLowerCase();
    const sub = subredditFn ? (subredditFn(item) || '').toLowerCase() : '';

    if (countryName && text.includes(countryName)) score += 3;
    if (countryName && sub.includes(countryName)) score += 2;

    // Check noise in post text AND in subreddit name (trim spaces so ' ph ' matches 'ph' in subreddit)
    for (const noise of noiseTerms) {
      if (text.includes(noise) || sub.includes(noise.trim())) {
        score -= 4;
        break;
      }
    }

    return { item, score };
  });

  scored.sort((a, b) => b.score - a.score);
  let filtered = scored.filter(s => s.score >= 0).map(s => s.item);
  if (filtered.length < 5) filtered = scored.filter(s => s.score >= -2).map(s => s.item);
  if (filtered.length < 3) filtered = items;
  return filtered.slice(0, 10);
}

const APIFY_BASE = 'https://api.apify.com/v2';
const APIFY_TOKEN = process.env.APIFY_TOKEN;

async function startActor(actorId, input) {
  const res = await fetch(`${APIFY_BASE}/acts/${actorId}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input)
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Actor start failed (${res.status}): ${body}`);
  }
  const data = await res.json();
  return data.data;
}

async function pollRun(runId) {
  for (let i = 0; i < 80; i++) {
    await new Promise(r => setTimeout(r, 3000));
    const res = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!res.ok) continue;
    const data = await res.json();
    const status = data.data.status;
    if (status === 'SUCCEEDED') return data.data;
    if (status === 'FAILED' || status === 'ABORTED') throw new Error(`Actor run ${status}`);
  }
  throw new Error('Actor run timed out after ~4 minutes');
}

async function fetchDataset(datasetId) {
  const res = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?limit=25&clean=true&token=${APIFY_TOKEN}`);
  if (!res.ok) throw new Error(`Dataset fetch failed (${res.status})`);
  return res.json();
}

async function runTikTok(brand, countryCode, tiktokHandle) {
  const countryName = COUNTRY_MAP[countryCode] || countryCode;
  let results = [];

  // If a handle is provided, scrape the brand's own profile in parallel with search
  const jobs = [
    startActor('clockworks~tiktok-scraper', {
      searchQueries: [`${brand} ${countryName}`],
      resultsPerPage: 10,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSlideshowImages: false,
      shouldDownloadSubtitles: false
    }),
    startActor('clockworks~tiktok-scraper', {
      searchQueries: [brand],
      resultsPerPage: 10,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSlideshowImages: false,
      shouldDownloadSubtitles: false
    })
  ];

  if (tiktokHandle) {
    jobs.push(startActor('clockworks~tiktok-scraper', {
      profiles: [tiktokHandle],
      resultsPerPage: 15,
      shouldDownloadVideos: false,
      shouldDownloadCovers: false,
      shouldDownloadSlideshowImages: false,
      shouldDownloadSubtitles: false
    }));
  }

  const settled = await Promise.allSettled(
    jobs.map(async jobPromise => {
      const run = await jobPromise;
      const finished = await pollRun(run.id);
      return fetchDataset(finished.defaultDatasetId);
    })
  );
  for (const r of settled) {
    if (r.status === 'fulfilled') results.push(...r.value);
  }

  const seen = new Set();
  const deduped = results.filter(item => {
    const key = item.webVideoUrl || item.id || Math.random();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const geoFiltered = geoScore(deduped, countryCode,
    item => `${item.text || item.desc || item.description || ''} ${item.authorMeta?.name || item.author?.uniqueId || ''}`,
    null
  );

  return geoFiltered.slice(0, 10).map(item => ({
    text: item.text || item.desc || item.description || '',
    author: item.authorMeta?.name || item.author?.uniqueId || '',
    url: item.webVideoUrl || '',
    likes: item.diggCount || 0,
    comments: item.commentCount || 0
  }));
}

async function runInstagram(brand, instagramHandle) {
  // Use the provided handle if available; otherwise guess from brand name
  const handle = instagramHandle || brand.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Run all three scrapers in parallel; failures are non-fatal
  const scraperJobs = [
    {
      actorId: 'apify~instagram-hashtag-scraper',
      input: {
        hashtags: [handle],
        resultsLimit: 8,
        resultsType: 'posts',
        proxyConfiguration: { useApifyProxy: true }
      }
    },
    {
      actorId: 'apify~instagram-tagged-scraper',
      input: {
        usernames: [handle],
        resultsLimit: 8,
        proxyConfiguration: { useApifyProxy: true }
      }
    },
    {
      actorId: 'apify~instagram-search-scraper',
      input: {
        search: brand,
        searchType: 'hashtag',
        searchLimit: 8,
        proxyConfiguration: { useApifyProxy: true }
      }
    }
  ];

  const settled = await Promise.allSettled(
    scraperJobs.map(async ({ actorId, input }) => {
      const run = await startActor(actorId, input);
      const finished = await pollRun(run.id);
      return fetchDataset(finished.defaultDatasetId);
    })
  );

  const allItems = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') allItems.push(...result.value);
  }

  // Deduplicate by URL / shortCode / id
  const seen = new Set();
  const deduped = allItems.filter(item => {
    const key = item.url || item.shortCode || item.id;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.slice(0, 10).map(item => ({
    text: item.caption || item.alt || '',
    hashtags: (item.hashtags || []).slice(0, 5).map(h => `#${h}`).join(' '),
    url: item.url || (item.shortCode ? `https://instagram.com/p/${item.shortCode}` : ''),
    likes: item.likesCount || 0,
    comments: item.commentsCount || 0
  }));
}

async function runReddit(brand, countryCode) {
  const countryName = COUNTRY_MAP[countryCode] || countryCode;
  let results = [];

  for (const query of [`${brand} ${countryName}`, brand]) {
    const run = await startActor('automation-lab~reddit-scraper', {
      mode: 'search',
      searchQuery: query,
      searchSort: 'relevance',
      maxResults: 15,
      includeComments: false,
      proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] }
    });
    const finished = await pollRun(run.id);
    const items = await fetchDataset(finished.defaultDatasetId);
    results.push(...items);
  }

  const seen = new Set();
  const deduped = results.filter(item => {
    const key = item.url || item.permalink;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Drop posts that don't mention the brand at all — Reddit search matches on
  // country name too, pulling in generic food/travel posts unrelated to the brand.
  const brandLower = brand.toLowerCase();
  const brandRelevant = deduped.filter(item => {
    const haystack = `${item.title || ''} ${item.selftext || item.body || ''} ${item.url || ''}`.toLowerCase();
    return haystack.includes(brandLower);
  });
  const toScore = brandRelevant.length >= 3 ? brandRelevant : deduped;

  const geoFiltered = geoScore(toScore, countryCode,
    item => `${item.title || item.name || ''} ${item.selftext || item.body || ''}`,
    item => item.subreddit || ''
  );

  return geoFiltered.slice(0, 10).map(item => ({
    title: item.title || item.name || '',
    body: (item.selftext || item.body || '').slice(0, 200),
    url: item.url || item.permalink || '',
    score: item.score || 0,
    subreddit: item.subreddit || ''
  }));
}

async function runGoogle(brand, countryCode) {
  const countryName = COUNTRY_MAP[countryCode] || countryCode;
  const run = await startActor('apify~google-search-scraper', {
    queries: `${brand} ${countryName}\n${brand} review ${countryName}`,
    countryCode: countryCode.toLowerCase(),
    languageCode: 'en',
    maxPagesPerQuery: 1,
    resultsPerPage: 10,
    mobileResults: false
  });
  const finished = await pollRun(run.id);
  const items = await fetchDataset(finished.defaultDatasetId);

  const flat = [];
  for (const item of items) {
    if (Array.isArray(item.organicResults) && item.organicResults.length > 0) {
      flat.push(...item.organicResults);
    } else if (item.title || item.description) {
      flat.push(item);
    }
  }

  return flat.slice(0, 10).map(item => ({
    title: item.title || '',
    description: item.description || item.snippet || '',
    url: item.url || item.link || ''
  }));
}

function formatScraperData(data) {
  const { tiktok, instagram, reddit, google } = data;
  let prompt = '';

  if (tiktok && tiktok.length > 0) {
    prompt += `\n\n=== TIKTOK (${tiktok.length} posts) ===\n`;
    tiktok.forEach((p, i) => {
      prompt += `${i + 1}. @${sanitize(p.author)}: "${sanitize(p.text).slice(0, 200)}" | Likes: ${p.likes} | Comments: ${p.comments}\n`;
    });
  } else {
    prompt += `\n\n=== TIKTOK ===\nNo data collected.\n`;
  }

  if (instagram && instagram.length > 0) {
    prompt += `\n\n=== INSTAGRAM (${instagram.length} posts) ===\n`;
    instagram.forEach((p, i) => {
      prompt += `${i + 1}. "${sanitize(p.text).slice(0, 200)}" | Tags: ${sanitize(p.hashtags)} | Likes: ${p.likes}\n`;
    });
  } else {
    prompt += `\n\n=== INSTAGRAM ===\nNo data collected.\n`;
  }

  if (reddit && reddit.length > 0) {
    prompt += `\n\n=== REDDIT (${reddit.length} posts) ===\n`;
    reddit.forEach((p, i) => {
      prompt += `${i + 1}. r/${sanitize(p.subreddit)} | "${sanitize(p.title)}" | Score: ${p.score}\n   ${sanitize(p.body)}\n`;
    });
  } else {
    prompt += `\n\n=== REDDIT ===\nNo data collected.\n`;
  }

  if (google && google.length > 0) {
    prompt += `\n\n=== GOOGLE SEARCH RESULTS (${google.length} results) ===\n`;
    google.forEach((p, i) => {
      prompt += `${i + 1}. "${sanitize(p.title)}" | ${sanitize(p.description).slice(0, 200)}\n`;
    });
  } else {
    prompt += `\n\n=== GOOGLE ===\nNo data collected.\n`;
  }

  return prompt;
}

function sanitize(str) {
  // Replace lone surrogates that make JSON invalid
  return String(str || '').replace(/[\uD800-\uDFFF]/g, c => {
    const code = c.charCodeAt(0);
    return (code >= 0xD800 && code <= 0xDBFF) || (code >= 0xDC00 && code <= 0xDFFF) ? '' : c;
  });
}

async function synthesise(brand, countryCode, scrapedData) {
  const countryName = COUNTRY_MAP[countryCode] || countryCode;
  const formattedData = formatScraperData(scrapedData);

  const userPrompt = `Analyse the following social media and web data about the brand "${brand}" in ${countryName} and return ONLY valid JSON (no markdown fences, no preamble, no explanation) matching this exact structure:

{
  "overallSentiment": "positive|mixed|neutral|negative",
  "sentimentScore": <integer 0-100>,
  "summary": "<2-3 paragraphs specific to actual data collected, written for a marketing strategist>",
  "keyThemes": ["theme1", "theme2", "theme3", "theme4", "theme5"],
  "platforms": {
    "tiktok":    { "sentiment": "positive|mixed|neutral|negative", "summary": "<1-2 sentences>", "signals": ["signal1", "signal2", "signal3"] },
    "instagram": { "sentiment": "positive|mixed|neutral|negative", "summary": "<1-2 sentences>", "signals": ["signal1", "signal2", "signal3"] },
    "reddit":    { "sentiment": "positive|mixed|neutral|negative", "summary": "<1-2 sentences>", "signals": ["signal1", "signal2", "signal3"] },
    "google":    { "sentiment": "positive|mixed|neutral|negative", "summary": "<1-2 sentences>", "signals": ["signal1", "signal2", "signal3"] }
  },
  "notableSignals": [
    { "text": "<direct quote or paraphrase>", "platform": "tiktok|instagram|reddit|google", "tone": "positive|negative|neutral" }
  ],
  "rawSentiment": {
    "tiktok":    ["positive|negative|neutral"],
    "instagram": ["positive|negative|neutral"],
    "reddit":    ["positive|negative|neutral"],
    "google":    ["positive|negative|neutral"]
  }
}

DATA:
${formattedData}`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2500,
    system: 'You are a brand sentiment analyst at a paid media agency.',
    messages: [{ role: 'user', content: userPrompt }]
  });

  let raw = response.content[0].text.trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');

  return JSON.parse(raw);
}

async function processRun(runId, brand, countryCode, tiktokHandle, instagramHandle) {
  const run = runs.get(runId);

  const scraperResults = { tiktok: [], instagram: [], reddit: [], google: [] };

  const scrapers = [
    {
      key: 'tiktok',
      actorId: 'clockworks~tiktok-scraper',
      fn: () => runTikTok(brand, countryCode, tiktokHandle)
    },
    {
      key: 'instagram',
      actorId: 'apify~instagram-hashtag-scraper',
      fn: () => runInstagram(brand, instagramHandle)
    },
    {
      key: 'reddit',
      actorId: 'automation-lab~reddit-scraper',
      fn: () => runReddit(brand, countryCode)
    },
    {
      key: 'google',
      actorId: 'apify~google-search-scraper',
      fn: () => runGoogle(brand, countryCode)
    }
  ];

  await Promise.all(scrapers.map(async ({ key, fn }) => {
    run.scrapers[key].status = 'running';
    try {
      const results = await fn();
      scraperResults[key] = results;
      run.scrapers[key].status = 'done';
      run.scrapers[key].count = results.length;
    } catch (err) {
      run.scrapers[key].status = 'failed';
      run.scrapers[key].message = err.message;
    }
  }));

  const totalResults = Object.values(scraperResults).reduce((sum, arr) => sum + arr.length, 0);
  if (totalResults === 0) {
    run.status = 'error';
    run.error = 'All four scrapers returned no data. Cannot perform sentiment analysis.';
    return;
  }

  try {
    const analysis = await synthesise(brand, countryCode, scraperResults);
    run.status = 'complete';
    run.result = { analysis, rawData: scraperResults, brand, countryCode, timestamp: new Date().toISOString() };
  } catch (err) {
    run.status = 'error';
    run.error = `Claude synthesis failed: ${err.message}`;
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.post('/api/run', (req, res) => {
  const { brand, countryCode, tiktokHandle, instagramHandle } = req.body;
  if (!brand || !countryCode) {
    return res.status(400).json({ error: 'brand and countryCode are required' });
  }
  if (!COUNTRY_MAP[countryCode]) {
    return res.status(400).json({ error: 'Invalid countryCode' });
  }

  const runId = uuidv4();
  const runData = {
    status: 'running',
    scrapers: {
      tiktok:    { status: 'queued', count: 0, message: '' },
      instagram: { status: 'queued', count: 0, message: '' },
      reddit:    { status: 'queued', count: 0, message: '' },
      google:    { status: 'queued', count: 0, message: '' }
    },
    result: null,
    error: null
  };
  runs.set(runId, runData);

  processRun(runId, brand, countryCode, tiktokHandle || null, instagramHandle || null).catch(err => {
    const run = runs.get(runId);
    if (run) {
      run.status = 'error';
      run.error = err.message;
    }
  });

  res.json({ runId });
});

app.get('/api/status/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json({
    status: run.status,
    scrapers: run.scrapers,
    error: run.error || undefined
  });
});

app.get('/api/result/:runId', (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'complete') return res.status(202).json({ status: run.status });

  const result = run.result;
  setTimeout(() => runs.delete(req.params.runId), 10 * 60 * 1000);
  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PULSE running on port ${PORT}`));
