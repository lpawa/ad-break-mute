importScripts('config.js'); // ANALYTICS_URL, ANALYTICS_DEFAULT_ON

// Mutes/unmutes the tab and shows the "back from the break" notification.
// Only ever unmutes a tab this extension muted, so a tab you muted yourself stays muted.
const mutedByUs = tab =>
  tab?.mutedInfo?.muted &&
  tab.mutedInfo.reason === 'extension' &&
  tab.mutedInfo.extensionId === chrome.runtime.id;

const setBadge = (tabId, on) => chrome.action.setBadgeText({ tabId, text: on ? 'AD' : '' });
chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'analytics') { Analytics.track(msg.event); return; }
  const tabId = sender.tab?.id;
  if (tabId == null) return;

  if (msg.type === 'set-mute') {
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab) return;
      if (msg.muted) {
        if (!tab.mutedInfo?.muted) chrome.tabs.update(tabId, { muted: true });
        if (!tab.mutedInfo?.muted || mutedByUs(tab)) setBadge(tabId, true);
      } else {
        if (mutedByUs(tab)) chrome.tabs.update(tabId, { muted: false });
        setBadge(tabId, false);
      }
    });
  }

  if (msg.type === 'notify') {
    chrome.notifications.create(`back:${tabId}:${sender.tab.windowId}`, {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: msg.title,
      message: msg.message || '',
      silent: true, // the page plays its own chime
      priority: 1,
    });
  }
});

chrome.notifications.onClicked.addListener(id => {
  const [kind, tabId, windowId] = id.split(':');
  if (kind !== 'back') return;
  chrome.tabs.update(+tabId, { active: true }, () => void chrome.runtime.lastError);
  chrome.windows.update(+windowId, { focused: true }, () => void chrome.runtime.lastError);
  chrome.notifications.clear(id);
});

// Clear a stale "match is back" notification once you return to the tab
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  chrome.notifications.clear(`back:${tabId}:${windowId}`);
});

// Don't leave a tab muted if it reloads mid-ad
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' && mutedByUs(tab)) {
    chrome.tabs.update(tabId, { muted: false });
    setBadge(tabId, false);
  }
});

/* ---------- Anonymous usage stats (opt-in) ----------
 * Only runs when ANALYTICS_URL is set in config.js, and the user either chose to share stats or hasn't chosen
 * while ANALYTICS_DEFAULT_ON is true (the beta default). Choosing "Turn off" always stops it.
 * Sends: a random install id, the extension version, the day, and events such as
 * { e: 'ad', site, secs, known, via, speed, brand } or { e: 'end', site, reason }.
 * Never sent: what you watch (titles, URLs, match or show ids), the time of day, or anything about you.
 */
const Analytics = (() => {
  const QUEUE = 'analyticsQueue';
  const MAX_QUEUE = 500;
  const FLUSH_AT = 20;
  const ALLOWED = ['e', 'site', 'secs', 'known', 'via', 'speed', 'brand', 'reason', 'settings'];

  const optedIn = async () => {
    if (!ANALYTICS_URL) return false;
    const { analytics } = await chrome.storage.sync.get({ analytics: null });
    return analytics === null ? ANALYTICS_DEFAULT_ON === true : analytics === true;
  };
  const today = () => new Date().toISOString().slice(0, 10);
  // Queue reads and writes run one at a time, so events arriving together aren't lost
  let chain = Promise.resolve();
  const serial = fn => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };

  async function installId() {
    let { installId } = await chrome.storage.local.get('installId');
    if (!installId) {
      installId = crypto.randomUUID();
      await chrome.storage.local.set({ installId });
    }
    return installId;
  }

  async function track(event) {
    if (!event || !(await optedIn())) return;
    const clean = { day: today() };
    for (const k of ALLOWED) if (event[k] !== undefined) clean[k] = event[k];
    const size = await serial(async () => {
      const { [QUEUE]: q = [] } = await chrome.storage.local.get({ [QUEUE]: [] });
      q.push(clean);
      await chrome.storage.local.set({ [QUEUE]: q.slice(-MAX_QUEUE) });
      return q.length;
    });
    if (size >= FLUSH_AT) flush();
  }

  async function flush() {
    if (!(await optedIn())) return;
    const q = await serial(async () => {
      const { [QUEUE]: items = [] } = await chrome.storage.local.get({ [QUEUE]: [] });
      if (items.length) await chrome.storage.local.set({ [QUEUE]: [] });
      return items;
    });
    if (!q.length) return;
    const body = JSON.stringify({ install: await installId(), version: chrome.runtime.getManifest().version, events: q });
    try {
      // text/plain + no-cors is a "simple" request Apps Script accepts without CORS setup; we don't need the reply
      await fetch(ANALYTICS_URL, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain' }, body });
    } catch {
      await serial(async () => { // offline: put the batch back for next time
        const { [QUEUE]: rest = [] } = await chrome.storage.local.get({ [QUEUE]: [] });
        await chrome.storage.local.set({ [QUEUE]: [...q, ...rest].slice(-MAX_QUEUE) });
      });
    }
  }

  // Once a day: which settings people actually use
  async function dailyPing() {
    if (!(await optedIn())) return;
    const { lastPing } = await chrome.storage.local.get('lastPing');
    if (lastPing === today()) return;
    await chrome.storage.local.set({ lastPing: today() });
    const keys = { enabled: true, overlay: true, alertWhenAway: true, speedThrough: true, speedRate: 8, extraSeconds: 1 };
    const s = await chrome.storage.sync.get(keys);
    await track({ e: 'daily', settings: Object.fromEntries(Object.keys(keys).map(k => [k, s[k]])) });
  }

  chrome.alarms.create('analytics', { periodInMinutes: 30 });
  chrome.alarms.onAlarm.addListener(a => { if (a.name === 'analytics') dailyPing().then(flush); });
  chrome.runtime.onStartup.addListener(() => dailyPing().then(flush));
  chrome.runtime.onInstalled.addListener(() => dailyPing().then(flush));

  // Opting out deletes the queue and the install id, so a later opt-in starts as a new install
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('analytics' in changes)) return;
    if (changes.analytics.newValue !== false) dailyPing().then(flush);
    else serial(() => chrome.storage.local.remove([QUEUE, 'installId', 'lastPing']));
  });

  return { track, flush };
})();
