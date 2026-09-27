const DEFAULTS = { enabled: true, extraSeconds: 1, fallbackSeconds: 30, overlay: true, alertWhenAway: true, speedThrough: true, speedRate: 8, analytics: null };
const ANALYTICS_ON = typeof ANALYTICS_URL === 'string' && ANALYTICS_URL.length > 0; // from config.js
const STATS_DEFAULT = typeof ANALYTICS_DEFAULT_ON !== 'undefined' && ANALYTICS_DEFAULT_ON === true;
const sharing = () => settings.analytics === null ? STATS_DEFAULT : settings.analytics === true;
const EMPTY_STATS = { total: { ads: 0, seconds: 0 }, brands: {}, matches: {}, sites: {} };
// Friendly names for the "open a supported site" message. Add one line per site module.
const SITE_NAMES = { hotstar: 'JioHotstar', primevideo: 'Prime Video' };
// Supported URLs, straight from the manifest's content script patterns
const SUPPORTED = chrome.runtime.getManifest().content_scripts
  .flatMap(c => c.matches)
  .map(p => new RegExp('^' + p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tab = null, status = null, onSupported = false, settings = { ...DEFAULTS }, ticker = null;

const fmt = s => {
  s = Math.round(s);
  if (s < 60) return `${s}s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}h ${m}m` : r ? `${m}m ${r}s` : `${m}m`;
};
const plural = (n, word) => `${word}${n === 1 ? '' : 's'}`;
const listNames = names => names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;

/* ---------- Main view ---------- */

function setStatus(mode, headline, sub = '', extra = '') {
  const el = $('#status');
  el.dataset.mode = mode;
  el.innerHTML = `<p class="state"><span class="dot"></span>${headline}</p>${sub ? `<p class="sub">${sub}</p>` : ''}${extra}`;
}

function renderStatus() {
  clearInterval(ticker);

  if (!onSupported) {
    return setStatus('idle', `Open ${esc(listNames(Object.values(SITE_NAMES)))}`, 'The tab mutes by itself when an ad starts.');
  }
  if (!status) {
    return setStatus('idle', 'Reload this tab', 'It was open before the extension was installed or updated.');
  }
  if (!settings.enabled) {
    return setStatus('idle', 'Paused', 'Ads will play with sound.');
  }

  const siteName = esc(status.site?.name || 'this site');
  const mi = tab.mutedInfo || {};
  const tabMutedByYou = mi.muted && !(mi.reason === 'extension' && mi.extensionId === chrome.runtime.id);
  const yourMute = tabMutedByYou
    ? "You've muted this tab, so it stays muted after ads."
    : status.playerMuted ? `${esc(status.site?.player || 'The player')} is muted, so it stays quiet after ads.` : '';

  if (status.muted) {
    const paint = () => {
      const left = Math.max(0, Math.ceil((status.unmuteAt - Date.now()) / 1000));
      const noun = status.site?.contentNoun || 'show';
      const speeding = status.speed > 1;
      setStatus('muted', speeding ? `Speeding through ads at ${status.speed}\u00d7` : 'Muting an ad', '',
        `<div class="countdown"><b>${left}s</b><span>until the ${esc(noun)} is back</span></div>` +
        (yourMute ? `<p class="sub">${yourMute}</p>` : `<button class="text-btn" id="unmute">${speeding ? 'Watch this ad normally' : 'Unmute now'}</button>`));
      const btn = $('#unmute');
      if (btn) btn.onclick = async () => {
        try { await chrome.tabs.sendMessage(tab.id, { type: 'unmute-now' }); } catch {}
        refresh();
      };
      if (left === 0) setTimeout(refresh, 600);
    };
    paint();
    ticker = setInterval(paint, 1000);
    return;
  }
  setStatus('listening', `Listening on ${siteName}`, yourMute || 'Mutes the tab when the next ad starts.');
}

async function renderStats() {
  const { stats = EMPTY_STATS } = await chrome.storage.local.get({ stats: EMPTY_STATS });
  const key = status?.site && status?.content ? `${status.site.id}:${status.content.id}` : null;
  const m = key && stats.matches[key];

  const stream = $('#stream');
  if (m) {
    const adNoun = m.adNoun || 'ad';
    const tops = Object.entries(m.brands || {}).sort((a, b) => b[1] - a[1]).slice(0, 3);
    stream.innerHTML = `
      <p class="stream-title" title="${esc(m.title)}">${esc(m.title)}</p>
      <div class="score">
        <div><b>${m.ads}</b><span>${esc(plural(m.ads, adNoun))} muted</span></div>
        <div><b>${fmt(m.seconds)}</b><span>of ads skipped</span></div>
      </div>
      ${tops.length ? `<p class="brands">Most shown: ${tops.map(([b, n]) => `<strong>${esc(b)}</strong> ${n}`).join(', ')}</p>` : ''}`;
    stream.hidden = false;
  } else {
    stream.hidden = true;
  }

  const all = $('#alltime');
  if (stats.total.ads) {
    const streams = Object.keys(stats.matches).length;
    const sites = Object.entries(stats.sites || {}).filter(([, s]) => s.ads).sort((a, b) => b[1].ads - a[1].ads);
    const bySite = sites.length > 1 ? ` (${sites.map(([id, s]) => `${esc(SITE_NAMES[id] || id)} ${s.ads}`).join(', ')})` : '';
    all.innerHTML = `All time: ${stats.total.ads} muted${bySite}, ${fmt(stats.total.seconds)} skipped across ${streams} ${plural(streams, 'stream')}.`;
    all.hidden = false;
  } else {
    all.hidden = true;
  }
}

/* ---------- Settings view ---------- */

const steppers = [...document.querySelectorAll('.stepper')];
function paintStepper(el) {
  const { key, min, max, unit } = el.dataset;
  const v = settings[key];
  el.querySelector('output').textContent = `${v}${unit}`;
  const [down, up] = el.querySelectorAll('button');
  down.disabled = v <= +min;
  up.disabled = v >= +max;
}
for (const el of steppers) {
  el.addEventListener('click', async e => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    const { key, min, max, step } = el.dataset;
    const next = Math.min(+max, Math.max(+min, Math.round((settings[key] + +btn.dataset.dir * +step) * 2) / 2));
    settings[key] = next;
    paintStepper(el);
    await chrome.storage.sync.set({ [key]: next });
  });
}

function paintSettings() {
  for (const key of ['enabled', 'overlay', 'alertWhenAway', 'speedThrough']) $('#' + key).checked = !!settings[key];
  $('#analytics').checked = sharing();
  $('#privacy-group').hidden = !ANALYTICS_ON;
  // Shown once, until they choose. During the beta, stats are already on, so it's a notice with a way out.
  $('#consent').hidden = !ANALYTICS_ON || settings.analytics !== null;
  if (STATS_DEFAULT) {
    $('#consent-title').textContent = 'Anonymous stats are on during the beta';
    $('#consent-text').textContent = 'It shares ad lengths and which sites and settings you use, never what you watch or who you are. You can change this in Settings.';
    $('#consent-yes').textContent = 'OK';
    $('#consent-no').textContent = 'Turn off';
  }
  $('#speed-row').hidden = !settings.speedThrough;
  steppers.forEach(paintStepper);
}

for (const key of ['enabled', 'overlay', 'alertWhenAway', 'speedThrough', 'analytics']) {
  $('#' + key).addEventListener('change', async e => {
    settings[key] = e.target.checked;
    paintSettings();
    await chrome.storage.sync.set({ [key]: e.target.checked });
    if (key === 'enabled') renderStatus();
  });
}

for (const [id, value] of [['#consent-yes', true], ['#consent-no', false]]) {
  $(id).addEventListener('click', async () => {
    settings.analytics = value;
    paintSettings();
    await chrome.storage.sync.set({ analytics: value });
  });
}

const showSettings = open => {
  $('#main-view').hidden = open;
  $('#settings-view').hidden = !open;
  (open ? $('#close-settings') : $('#open-settings')).focus();
};
$('#open-settings').addEventListener('click', () => showSettings(true));
$('#close-settings').addEventListener('click', () => { showSettings(false); refresh(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#settings-view').hidden) { e.preventDefault(); showSettings(false); } });

$('#reset').addEventListener('click', async e => {
  const btn = e.currentTarget;
  if (btn.dataset.confirm !== '1') {
    btn.dataset.confirm = '1';
    btn.textContent = 'Click again to reset ad stats';
    setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Reset ad stats'; }, 3000);
    return;
  }
  await chrome.storage.local.set({ stats: EMPTY_STATS, history: [] });
  btn.dataset.confirm = '';
  btn.textContent = 'Ad stats reset';
  setTimeout(() => { btn.textContent = 'Reset ad stats'; }, 2000);
  renderStats();
});

/* ---------- Load ---------- */

async function refresh() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  paintSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  onSupported = !!tab && SUPPORTED.some(re => re.test(tab.url || ''));
  status = null;
  if (onSupported) {
    try { status = await chrome.tabs.sendMessage(tab.id, { type: 'status' }); } catch {}
  }
  renderStatus();
  renderStats();
}

refresh();
