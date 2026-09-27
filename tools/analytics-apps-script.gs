/**
 * Ad Break Mute: receiver for anonymous usage stats.
 * Paste into a Google Sheet's Apps Script editor (Extensions → Apps Script), run setup() once,
 * then deploy as a web app. See docs/ANALYTICS.md.
 */
const EVENTS = 'events';
const SUMMARY = 'summary';
const HEADERS = ['received', 'install', 'version', 'day', 'event', 'site', 'ad_seconds', 'duration_known',
                 'detected_via', 'speed', 'brand', 'end_reason', 'settings'];
const MAX_EVENTS_PER_POST = 500;
const MAX_BODY_BYTES = 200000;

// Abuse limits. The web app URL ships inside the extension, so anyone with the extension can find it. These keep a
// misbehaving or malicious sender from flooding the sheet. Real testers send a batch every 30 minutes at most.
const MAX_POSTS_PER_INSTALL_PER_HOUR = 20;
const MAX_EVENTS_PER_HOUR_TOTAL = 5000;
const EVENT_TYPES = ['ad', 'end', 'ignored', 'speed-reset', 'daily', 'test'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VERSION = /^\d+\.\d+\.\d+$/;
const SITE = /^[a-z0-9-]{1,20}$/;

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) || '';
    if (raw.length > MAX_BODY_BYTES) return ok_();
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.events) || !data.events.length || data.events.length > MAX_EVENTS_PER_POST) return ok_();
    // Only batches shaped like the extension's: a random install id, a version, known event types
    if (!UUID.test(String(data.install)) || !VERSION.test(String(data.version))) return ok_();
    const events = data.events.filter(ev => ev && EVENT_TYPES.includes(ev.e) && (!ev.site || SITE.test(String(ev.site))));
    if (!events.length) return ok_();
    if (!withinLimits_(String(data.install), events.length)) return ok_();

    const now = new Date();
    const str = (v, n) => (v === undefined || v === null ? '' : String(v).slice(0, n));
    const rows = events.map(ev => [
      now,
      str(data.install, 36),
      str(data.version, 16),
      str(ev.day, 10),
      str(ev.e, 20),
      str(ev.site, 20),
      typeof ev.secs === 'number' ? ev.secs : '',
      typeof ev.known === 'boolean' ? ev.known : '',
      str(ev.via, 40),
      typeof ev.speed === 'number' ? ev.speed : '',
      str(ev.brand, 60),
      str(ev.reason, 60),
      ev.settings ? str(JSON.stringify(ev.settings), 300) : '',
    ]);

    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      const sh = eventsSheet_();
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);
    } finally {
      lock.releaseLock();
    }
  } catch (err) {
    console.error(err);
  }
  return ok_();
}

/** Run once from the editor: creates the events sheet and a summary sheet with live formulas. */
function setup() {
  eventsSheet_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY);
  sh.clear();
  const q = query => `=IFERROR(QUERY(${EVENTS}!A:M, "${query}", 1), "No data yet")`;
  const blocks = [
    ['Testers (installs that shared stats)', `=COUNTUNIQUE(${EVENTS}!B2:B)`],
    ['Ads handled', `=COUNTIF(${EVENTS}!E2:E, "ad")`],
    ['Ads by site', q("select F, count(E), sum(G) where E = 'ad' group by F label count(E) 'ads', sum(G) 'ad seconds'")],
    ['Ads with an unknown length (30s guess used)', q("select F, count(E) where E = 'ad' and H = false group by F label count(E) 'ads'")],
    ['How ads were spotted', q("select F, I, count(E) where E = 'ad' group by F, I label count(E) 'ads'")],
    ['How ad breaks ended', q("select F, L, count(E) where E = 'end' group by F, L label count(E) 'times'")],
    ['Most shown brands (JioHotstar)', q("select K, count(E) where E = 'ad' and K <> '' group by K order by count(E) desc limit 15 label count(E) 'ads'")],
    ['Problems: speed reset by the player, ignored impressions', q("select F, E, L, count(B) where E = 'speed-reset' or E = 'ignored' group by F, E, L label count(B) 'times'")],
    ['Versions in use', q("select C, count(B) group by C label count(B) 'events'")],
  ];
  let row = 1;
  for (const [title, formula] of blocks) {
    sh.getRange(row, 1).setValue(title).setFontWeight('bold');
    sh.getRange(row + 1, 1).setFormula(formula);
    row += 20;
  }
  sh.setColumnWidth(1, 320);
}

function eventsSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EVENTS);
  if (!sh) {
    sh = ss.insertSheet(EVENTS);
    sh.appendRow(HEADERS);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Per-install and overall hourly caps, kept in the script cache (resets on its own). */
function withinLimits_(install, eventCount) {
  const cache = CacheService.getScriptCache();
  const hour = Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const perKey = `posts:${install}:${hour}`, totalKey = `events:${hour}`;
  const posts = Number(cache.get(perKey) || 0), total = Number(cache.get(totalKey) || 0);
  if (posts >= MAX_POSTS_PER_INSTALL_PER_HOUR || total + eventCount > MAX_EVENTS_PER_HOUR_TOTAL) return false;
  cache.put(perKey, String(posts + 1), 3600);
  cache.put(totalKey, String(total + eventCount), 3600);
  return true;
}

// No doGet: opening the URL in a browser returns an error page and never any data.

function ok_() {
  return ContentService.createTextOutput('ok');
}
