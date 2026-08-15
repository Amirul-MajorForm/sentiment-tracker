const COUNTRY_NAMES = {
  SG: 'Singapore', MY: 'Malaysia', ID: 'Indonesia',
  TH: 'Thailand', PH: 'Philippines', VN: 'Vietnam',
  AU: 'Australia', GB: 'United Kingdom', US: 'United States',
  IN: 'India', JP: 'Japan', KR: 'South Korea',
  HK: 'Hong Kong', TW: 'Taiwan'
};

const PLATFORM_ICONS = {
  tiktok: '🎵', instagram: '📸', reddit: '🔴', google: '🔍'
};

let pollTimer = null;
let currentRunId = null;

// ── Views ──
function showView(id) {
  document.getElementById('input-view').style.display = id === 'input' ? 'block' : 'none';
  document.getElementById('loading-view').style.display = id === 'loading' ? 'block' : 'none';
  document.getElementById('results-view').style.display = id === 'results' ? 'block' : 'none';
}

// ── Input handlers ──
document.getElementById('brand-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') startRun();
});
document.getElementById('run-btn').addEventListener('click', startRun);
document.getElementById('new-run-btn').addEventListener('click', resetToInput);

// ── Handles toggle ──
document.getElementById('handles-toggle').addEventListener('click', () => {
  const body = document.getElementById('handles-body');
  const chevron = document.getElementById('handles-chevron');
  body.classList.toggle('open');
  chevron.classList.toggle('open');
});

// ── Tabs ──
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById(btn.dataset.tab).classList.add('active');
  });
});

async function startRun() {
  const brand = document.getElementById('brand-input').value.trim();
  const countryCode = document.getElementById('country-select').value;
  const tiktokHandle = document.getElementById('tiktok-handle').value.trim().replace(/^@/, '');
  const instagramHandle = document.getElementById('instagram-handle').value.trim().replace(/^@/, '');

  const errorEl = document.getElementById('input-error');
  errorEl.classList.remove('visible');

  if (!brand) {
    errorEl.textContent = 'Please enter a brand name.';
    errorEl.classList.add('visible');
    return;
  }

  document.getElementById('run-btn').disabled = true;

  // Reset loading cards
  ['tiktok', 'instagram', 'reddit', 'google'].forEach(p => {
    setScraperState(p, 'queued', 'Queued');
  });

  document.getElementById('loading-title').textContent = `Analysing "${brand}" in ${COUNTRY_NAMES[countryCode]}…`;
  showView('loading');

  try {
    const body = { brand, countryCode };
    if (tiktokHandle) body.tiktokHandle = tiktokHandle;
    if (instagramHandle) body.instagramHandle = instagramHandle;

    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to start run');
    }
    const { runId } = await res.json();
    currentRunId = runId;
    pollTimer = setInterval(() => pollStatus(runId, brand, countryCode), 3000);
  } catch (err) {
    document.getElementById('run-btn').disabled = false;
    showView('input');
    const errorEl = document.getElementById('input-error');
    errorEl.textContent = `Error: ${err.message}`;
    errorEl.classList.add('visible');
  }
}

async function pollStatus(runId, brand, countryCode) {
  try {
    const res = await fetch(`/api/status/${runId}`);
    if (!res.ok) return;
    const data = await res.json();

    if (data.scrapers) {
      for (const [platform, info] of Object.entries(data.scrapers)) {
        if (info.status === 'queued') {
          setScraperState(platform, 'queued', 'Queued');
        } else if (info.status === 'running') {
          setScraperState(platform, 'running', 'Running…');
        } else if (info.status === 'done') {
          setScraperState(platform, 'done', `${info.count} result${info.count !== 1 ? 's' : ''}`);
        } else if (info.status === 'failed') {
          setScraperState(platform, 'failed', `Failed: ${info.message || 'unknown error'}`);
        }
      }
    }

    if (data.status === 'complete') {
      clearInterval(pollTimer);
      const resultRes = await fetch(`/api/result/${runId}`);
      if (!resultRes.ok) throw new Error('Failed to fetch result');
      const result = await resultRes.json();
      renderResults(result, brand, countryCode);
    } else if (data.status === 'error') {
      clearInterval(pollTimer);
      document.getElementById('run-btn').disabled = false;
      showView('input');
      const errorEl = document.getElementById('input-error');
      errorEl.textContent = `Error: ${data.error || 'Unknown error'}`;
      errorEl.classList.add('visible');
    }
  } catch (err) {
    console.error('Poll error:', err);
  }
}

function setScraperState(platform, state, text) {
  const spinner = document.getElementById(`spin-${platform}`);
  const icon = document.getElementById(`icon-${platform}`);
  const statusEl = document.getElementById(`status-${platform}`);

  spinner.classList.toggle('active', state === 'running');
  statusEl.className = `scraper-status-text ${state}`;
  statusEl.textContent = text;

  if (state === 'done') {
    icon.textContent = '✓';
    icon.classList.add('visible');
  } else if (state === 'failed') {
    icon.textContent = '✕';
    icon.classList.add('visible');
  } else {
    icon.classList.remove('visible');
  }
}

function sentimentClass(s) {
  return ['positive','negative','mixed','neutral'].includes(s) ? s : 'neutral';
}

function pillHTML(sentiment) {
  const cls = sentimentClass(sentiment);
  const label = sentiment || 'neutral';
  return `<span class="pill ${cls}">${label}</span>`;
}

function renderResults(result, brand, countryCode) {
  const { analysis, rawData, timestamp } = result;
  const countryName = COUNTRY_NAMES[countryCode] || countryCode;
  const ts = new Date(timestamp).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  document.getElementById('res-brand').textContent = brand;
  document.getElementById('res-meta').textContent = `${countryName} · ${ts}`;

  // Score + bar
  const score = analysis.sentimentScore || 0;
  const cls = sentimentClass(analysis.overallSentiment);
  const scoreEl = document.getElementById('res-score');
  scoreEl.textContent = score;
  scoreEl.className = `sentiment-score-num ${cls}`;
  document.getElementById('res-verdict-pill').innerHTML = pillHTML(analysis.overallSentiment);
  const bar = document.getElementById('res-bar');
  bar.style.width = `${score}%`;
  bar.className = `sentiment-bar-fill ${cls}`;

  // Summary
  const summaryEl = document.getElementById('res-summary');
  const paras = (analysis.summary || '').split(/\n+/).filter(Boolean);
  summaryEl.innerHTML = paras.map(p => `<p>${escapeHtml(p)}</p>`).join('');

  // Themes
  const themesEl = document.getElementById('res-themes');
  themesEl.innerHTML = (analysis.keyThemes || []).map(t =>
    `<li><span class="theme-dot"></span>${escapeHtml(t)}</li>`
  ).join('');

  // Stats
  const statsEl = document.getElementById('res-stats');
  const platforms = ['tiktok', 'instagram', 'reddit', 'google'];
  const total = platforms.reduce((s, p) => s + (rawData[p] ? rawData[p].length : 0), 0);
  statsEl.innerHTML = `
    <div class="stat-item">
      <div class="stat-num">${total}</div>
      <div class="stat-desc">Items Collected</div>
    </div>
    <div class="stat-item">
      <div class="stat-num">4</div>
      <div class="stat-desc">Platforms Scraped</div>
    </div>
  `;

  // Platform breakdown
  const platformsEl = document.getElementById('res-platforms');
  const platformData = analysis.platforms || {};
  platformsEl.innerHTML = platforms.map(p => {
    const pd = platformData[p] || {};
    const pcls = sentimentClass(pd.sentiment);
    const signals = (pd.signals || []).map(s => `<li>${escapeHtml(s)}</li>`).join('');
    return `
      <div class="platform-card">
        <div class="platform-card-header">
          <div class="platform-name-row">
            <span class="platform-icon">${PLATFORM_ICONS[p]}</span>
            <span>${capitalise(p)}</span>
          </div>
          ${pillHTML(pd.sentiment)}
        </div>
        <div class="platform-summary">${escapeHtml(pd.summary || '')}</div>
        <ul class="platform-signals">${signals}</ul>
      </div>
    `;
  }).join('');

  // Notable signals
  const signalsEl = document.getElementById('res-signals');
  const notableSignals = (analysis.notableSignals || []).slice(0, 9);
  signalsEl.innerHTML = notableSignals.map(s => `
    <div class="signal-card">
      <div class="signal-quote">"${escapeHtml(s.text)}"</div>
      <div class="signal-footer">
        <span class="signal-source">${PLATFORM_ICONS[s.platform] || ''} ${capitalise(s.platform || '')}</span>
        ${pillHTML(s.tone)}
      </div>
    </div>
  `).join('');

  // Raw results tabs
  const rawSentiment = analysis.rawSentiment || {};
  platforms.forEach(p => {
    const el = document.getElementById(`raw-${p}`);
    const items = rawData[p] || [];
    const sentiments = rawSentiment[p] || [];
    if (items.length === 0) {
      el.innerHTML = `<div style="padding:24px 0;color:var(--text-tertiary);font-size:13px;">No data collected from this platform.</div>`;
      return;
    }
    el.innerHTML = items.map((item, i) => {
      const tone = sentiments[i] || 'neutral';
      const text = rawItemText(p, item);
      const url = item.url || '';
      return `
        <div class="raw-item">
          <div class="raw-num">${i + 1}</div>
          <div class="raw-content">
            <div class="raw-text">${escapeHtml(text.slice(0, 180))}${text.length > 180 ? '…' : ''}</div>
            ${url ? `<div class="raw-url"><a href="${escapeAttr(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></div>` : ''}
          </div>
          <div class="raw-tone">${pillHTML(tone)}</div>
        </div>
      `;
    }).join('');
  });

  // Footer
  document.getElementById('res-footer-market').textContent = `Market: ${countryName}`;

  document.getElementById('run-btn').disabled = false;
  showView('results');
}

function rawItemText(platform, item) {
  if (platform === 'tiktok') return item.text || '';
  if (platform === 'instagram') return item.text || '';
  if (platform === 'reddit') return `${item.title || ''} — ${item.body || ''}`.trim();
  if (platform === 'google') return `${item.title || ''} — ${item.description || ''}`.trim();
  return '';
}

function resetToInput() {
  if (pollTimer) clearInterval(pollTimer);
  currentRunId = null;
  document.getElementById('input-error').classList.remove('visible');
  document.getElementById('res-error').classList.remove('visible');
  showView('input');
}

function capitalise(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(str) {
  return String(str).replace(/"/g, '%22');
}

// Init
showView('input');
