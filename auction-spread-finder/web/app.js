const $ = (id) => document.getElementById(id);
const money = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
const money2 = (n) => `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let pollTimer = null;

async function load() {
  const params = new URLSearchParams({
    minSpread: $('minSpread').value,
    minConfidence: String(Number($('minConfidence').value) / 100),
  });

  const res = await fetch(`/api/opportunities?${params}`);
  const data = await res.json();

  renderStats(data.stats);
  renderBanner(data.stats);
  renderResults(data.opportunities, data.stats);
}

let currentConfig = null;

async function loadConfig() {
  const cfg = await (await fetch('/api/config')).json();
  currentConfig = cfg;

  $('locationLabel').textContent = `${cfg.location.zip} · within ${cfg.location.radiusMiles} mi`;

  // Only show a sign-out link where there's a session to sign out of.
  if (cfg.authEnabled && !document.getElementById('logoutLink')) {
    const a = document.createElement('a');
    a.id = 'logoutLink';
    a.href = '/logout';
    a.className = 'logout';
    a.textContent = 'Sign out';
    document.querySelector('.actions').append(a);
  }
  $('minSpread').value = cfg.filters.minSpreadDollars;
  $('minConfidence').value = Math.round(cfg.filters.minConfidence * 100);
  $('confVal').textContent = `${Math.round(cfg.filters.minConfidence * 100)}%`;

  // Mirror config into the settings form.
  $('setSources').value = cfg.sources.map((s) => s.url).join('\n');
  $('setPremium').value = round(cfg.economics.buyersPremiumPct * 100, 2);
  $('setTax').value = round(cfg.economics.salesTaxPct * 100, 2);
  $('setShip').value = cfg.economics.assumedShippingCost;

  const has = cfg.ebay.hasCredentials;
  $('ebayState').textContent = has ? '· saved' : '· not set';
  $('ebayState').className = has ? 'ok' : 'missing';
  $('setEbayId').placeholder = has ? '••••••  (saved — leave blank to keep)' : 'paste your App ID';
  $('setEbaySecret').placeholder = has ? '••••••  (saved — leave blank to keep)' : 'paste your Cert ID';

  $('setApifyEnabled').checked = Boolean(cfg.apify.enabled);
  $('setApifyActor').value = cfg.apify.actorId ?? '';
  $('setApifyMode').value = cfg.apify.mode ?? 'last';
  $('setApifyInput').value = JSON.stringify(cfg.apify.input ?? {}, null, 2);

  const hasApify = cfg.apify.hasToken;
  $('apifyState').textContent = hasApify ? '· saved' : '· not set';
  $('apifyState').className = hasApify ? 'ok' : 'missing';
  $('setApifyToken').placeholder = hasApify
    ? '••••••  (saved — leave blank to keep)'
    : 'paste your Apify token';

  $('setCompSource').value = cfg.comps?.source ?? 'ebay-api';
  $('setCompActor').value = cfg.comps?.apify?.actorId ?? '';
  $('setCompSold').checked = Boolean(cfg.comps?.apify?.isSoldData);
  $('setCompInput').value = JSON.stringify(cfg.comps?.apify?.inputTemplate ?? {}, null, 2);

  syncApifyFields();
  syncCompFields();
}

/** Show only the credential fields the chosen comp source actually needs. */
function syncCompFields() {
  const source = $('setCompSource').value;
  // 'auto' uses both, so both sets of credentials have to be reachable.
  $('compApifyPanel').hidden = source === 'ebay-api';
  $('ebayKeysRow').hidden = source === 'apify';
}

/** Actor input only matters when we're triggering runs ourselves. */
function syncApifyFields() {
  const on = $('setApifyEnabled').checked;
  const running = $('setApifyMode').value === 'run';
  for (const id of ['setApifyToken', 'setApifyActor', 'setApifyMode', 'setApifyInput']) {
    $(id).disabled = !on;
  }
  $('apifyInputField').style.opacity = on && running ? '1' : '0.45';
}

async function saveSettings() {
  const btn = $('saveSettings');
  btn.disabled = true;
  $('saveMsg').textContent = 'Saving…';
  $('saveMsg').className = 'save-msg';

  // Validate the Actor input before saving — a JSON typo here would otherwise
  // only surface as a confusing Apify error on the next refresh.
  let apifyInput;
  try {
    apifyInput = JSON.parse($('setApifyInput').value || '{}');
  } catch (err) {
    $('saveMsg').textContent = `Actor input isn't valid JSON: ${err.message}`;
    $('saveMsg').className = 'save-msg bad';
    btn.disabled = false;
    return;
  }

  let compInput;
  try {
    compInput = JSON.parse($('setCompInput').value || '{}');
  } catch (err) {
    $('saveMsg').textContent = `Comp Actor input isn't valid JSON: ${err.message}`;
    $('saveMsg').className = 'save-msg bad';
    btn.disabled = false;
    return;
  }

  const body = {
    comps: {
      source: $('setCompSource').value,
      apify: {
        actorId: $('setCompActor').value,
        isSoldData: $('setCompSold').checked,
        inputTemplate: compInput,
      },
    },
    sources: $('setSources').value.split('\n'),
    ebay: { clientId: $('setEbayId').value, clientSecret: $('setEbaySecret').value },
    apify: {
      enabled: $('setApifyEnabled').checked,
      token: $('setApifyToken').value,
      actorId: $('setApifyActor').value,
      mode: $('setApifyMode').value,
      input: apifyInput,
    },
    economics: {
      buyersPremiumPct: Number($('setPremium').value) / 100,
      salesTaxPct: Number($('setTax').value) / 100,
      assumedShippingCost: Number($('setShip').value),
    },
  };

  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error ?? `HTTP ${res.status}`);

    // Clear secret fields so they aren't left sitting on screen.
    $('setEbaySecret').value = '';
    $('setEbayId').value = '';
    $('setApifyToken').value = '';
    await loadConfig();

    $('saveMsg').textContent = 'Saved. Hit Refresh to use the new settings.';
    $('saveMsg').className = 'save-msg ok';
  } catch (err) {
    $('saveMsg').textContent = `Could not save: ${err.message}`;
    $('saveMsg').className = 'save-msg bad';
  } finally {
    btn.disabled = false;
  }
}

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function renderStats(stats) {
  $('stats').innerHTML =
    `${stats.passing} of ${stats.totalPriced} priced lots clear your bar<br>` +
    `<span style="opacity:0.7">${stats.totalTracked} lots tracked total</span>`;

  const run = stats.lastRun;
  $('lastRun').textContent = run
    ? `updated ${timeAgo(new Date(run.at))}`
    : 'never refreshed';
}

/** Surface setup problems prominently -- silent zero-results is the worst UX here. */
function renderBanner(stats) {
  const banner = $('banner');
  const run = stats.lastRun;

  // While a refresh is in flight the progress bar already says what's
  // happening; "no data yet" alongside it is both wrong and alarming.
  const refreshing = !$('progress').hidden;

  if (!run) {
    banner.hidden = refreshing;
    if (!refreshing) {
      banner.innerHTML = 'No data yet. Hit <b>Refresh</b> to scrape AuctionNinja and price the lots.';
    }
    return;
  }

  const msgs = [...(run.warnings ?? []), ...(run.errors ?? [])];
  if (msgs.length > 0) {
    banner.hidden = false;
    banner.innerHTML = msgs.map(escapeHtml).join('<br><br>');
    return;
  }
  banner.hidden = true;
}

function renderResults(lots, stats) {
  const el = $('results');

  if (lots.length === 0) {
    el.innerHTML = `<div class="empty">
      <h2>No lots clear ${money($('minSpread').value)} net spread right now</h2>
      <p>${stats.totalPriced > 0
        ? `${stats.totalPriced} lots priced, none clearing your bar. That is normal on a slow day — try lowering the spread or confidence sliders.`
        : 'Nothing has been priced yet — refresh, and check the notice above.'}</p>
    </div>`;
    return;
  }

  el.innerHTML = lots.map(renderLot).join('');
}

function renderLot(lot) {
  const v = lot.valuation;
  const c = lot.confidence;
  const conf = Math.round(c.score * 100);
  const cls = conf >= 65 ? 'high' : conf >= 45 ? 'med' : 'low';

  // Estate-listing images 404 often enough that a broken-image icon is common.
  const img = lot.image
    ? `<img src="${escapeHtml(lot.image)}" alt="" loading="lazy"
         onerror="this.outerHTML='&lt;div class=\\'noimg\\'&gt;no image&lt;/div&gt;'">`
    : `<div class="noimg">no image</div>`;

  const ends = lot.endsAt
    ? `<span>closes ${timeUntil(new Date(lot.endsAt))}</span>`
    : '';

  const comps = (lot.comps ?? []).map((comp) => `
    <li>
      <span class="comp-price">${money2(comp.price)}</span>
      <a href="${escapeHtml(comp.url)}" target="_blank" rel="noopener">${escapeHtml(comp.title)}</a>
    </li>`).join('');

  return `
  <article class="lot">
    ${img}
    <div>
      <h3 class="lot-title">
        ${lot.url ? `<a href="${escapeHtml(lot.url)}" target="_blank" rel="noopener">${escapeHtml(lot.title)}</a>`
                  : escapeHtml(lot.title)}
      </h3>
      <div class="meta">
        <span class="badge ${cls}">${conf}% confidence</span>
        ${ends}
        ${lot.location ? `<span>${escapeHtml(lot.location)}</span>` : ''}
        <span>searched: “${escapeHtml(lot.query ?? '')}”</span>
      </div>

      ${lot.url ? `<a class="bid-link" href="${escapeHtml(lot.url)}" target="_blank" rel="noopener">
        Open on AuctionNinja
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor"
             stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 1.5h6v6M10.5 1.5L5 7M8 9.5v1h-6.5v-9h1"/>
        </svg>
      </a>` : ''}

      <div class="math">
        <div>
          <span class="k">Current bid</span>
          <span class="v">${v.hasBid ? money2(v.currentBid) : '<span class="nobid">none listed</span>'}</span>
        </div>
        <div>
          <span class="k">+ premium/tax${v.premiumSource === 'listing' ? '' : ' *'}</span>
          <span class="v">${v.hasBid ? money2(v.buyCost.total) : '—'}</span>
        </div>
        <div><span class="k">${v.compBasis === 'sold' ? 'eBay median sold' : 'eBay median ask'}</span><span class="v">${money2(v.market.askMedian)}</span></div>
        <div><span class="k">Est. sale price</span><span class="v">${money2(v.market.estimatedSalePrice)}</span></div>
        <div><span class="k">− eBay fees/ship</span><span class="v">${money2(v.sell.net)}</span></div>
        <div><span class="k">ROI</span><span class="v">${v.roi != null ? `${Math.round(v.roi * 100)}%` : '—'}</span></div>
      </div>

      <details class="comps">
        <summary>${lot.comps?.length ?? 0} eBay comps · why ${conf}% confidence</summary>
        <ul class="comp-list">${comps}</ul>
        <div class="reasons">
          ${(c.reasons ?? []).map(escapeHtml).join(' · ')}
          <br>
          ${v.premiumSource === 'listing'
            ? `buyer's premium read from the listing`
            : `* buyer's premium not found on the listing — using your Settings default, so verify it before bidding`}
        </div>
      </details>
    </div>

    <div class="spread">
      ${v.hasBid ? `
        <span class="big">${money(v.netSpread)}</span>
        <span class="lbl">net spread at current bid</span>
        <div class="maxbid">
          <span class="lbl">bid up to</span><br>
          <b>${money2(v.maxBid)}</b>
        </div>
      ` : `
        <span class="big">${money(v.market.estimatedSalePrice)}</span>
        <span class="lbl">est. resale value</span>
        <div class="maxbid">
          <span class="lbl">pay no more than</span><br>
          <b>${money2(v.maxBid)}</b>
          <span class="lbl">to clear ${money($('minSpread').value)}</span>
        </div>
      `}
    </div>
  </article>`;
}

/* ---- refresh ---- */

async function startRefresh() {
  $('refreshBtn').disabled = true;
  $('progress').hidden = false;
  $('progressLog').textContent = 'starting…';

  const res = await fetch('/api/refresh', { method: 'POST' });
  if (res.status === 409) {
    $('progressLog').textContent = 'A refresh is already running.';
  }
  // Slower than the old modal polled: each tick now also re-renders the list,
  // and pricing a lot takes far longer than a second anyway.
  pollTimer = setInterval(pollStatus, 2500);
  pollStatus();
}

async function pollStatus() {
  const state = await (await fetch('/api/refresh-status')).json();
  $('progressLog').textContent = state.log.slice(-14).join('\n');

  // Show what's been priced so far, and refresh the list underneath, so a
  // long pricing pass reveals results as they land instead of all at once.
  $('progressNow').textContent =
    `${state.priced} of ${state.tracked} lots priced — results appear below as they finish`;
  await load();

  if (!state.running) {
    clearInterval(pollTimer);
    $('progress').hidden = true;
    $('refreshBtn').disabled = false;
    await load();
  }
}

/* ---- helpers ---- */

function timeAgo(date) {
  const mins = Math.floor((Date.now() - date.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function timeUntil(date) {
  const mins = Math.floor((date.getTime() - Date.now()) / 60000);
  if (mins < 0) return 'ended';
  if (mins < 60) return `in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `in ${hrs}h`;
  return `in ${Math.floor(hrs / 24)}d`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/* ---- wire up ---- */
$('refreshBtn').addEventListener('click', startRefresh);
$('settingsBtn').addEventListener('click', () => {
  const panel = $('settings');
  panel.hidden = !panel.hidden;
  if (!panel.hidden) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('closeSettings').addEventListener('click', () => { $('settings').hidden = true; });
$('saveSettings').addEventListener('click', saveSettings);
$('setApifyEnabled').addEventListener('change', syncApifyFields);
$('setApifyMode').addEventListener('change', syncApifyFields);
$('setCompSource').addEventListener('change', syncCompFields);
$('progressToggle').addEventListener('click', () => {
  const log = $('progressLog');
  log.hidden = !log.hidden;
  $('progressToggle').textContent = log.hidden ? 'Details' : 'Hide';
});
$('minSpread').addEventListener('change', load);
$('minConfidence').addEventListener('input', (e) => {
  $('confVal').textContent = `${e.target.value}%`;
});
$('minConfidence').addEventListener('change', load);

await loadConfig();
await load();
