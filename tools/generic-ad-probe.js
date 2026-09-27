/* Generic ad-break probe (any streaming site)
 * Paste into the DevTools CONSOLE on the site once something with ads is playing, then watch 3–5 ad breaks,
 * marking each one. It logs every signal that might mark an ad, so you can see which ones line up with your marks:
 *   - ad requests and beacons, VAST/VMAP responses and their tracking URLs
 *   - request bodies that mention ads (batched player telemetry)
 *   - HLS/DASH manifest markers (SCTE-35, CUE-OUT/IN, DATERANGE, EventStream, Periods)
 *   - Google IMA SDK ad events, if the site uses IMA
 *   - on-screen ad UI: "Ad", "Ad 1 of 2", "Ad 0:24" countdowns, ad-ish class names appearing or toggling
 *     (e.g. YouTube's "ad-showing"), and elements you point it at
 *   - the <video> element: resolution changes, pauses, time jumps, metadata cues, MSE buffer changes
 *
 *   Option+A (Alt+A) -> mark "ad on screen"   (click the video first so the page has focus)
 *   Option+M (Alt+M) -> mark "show back"
 *   __adProbe.mark('ad on screen') / mark('show back')   the same, from the Console (no focus needed)
 *   __adProbe.report()                         after a few marked breaks: which signals line up with your marks
 *   __adProbe.summary() / summary('dom')       compact table of events (optional type prefix filter)
 *   __adProbe.adText()                         every ad-looking text seen on screen, with timestamps
 *   __adProbe.watch('.selector', 'label')      track visibility of an element you found
 *   __adProbe.watchTree('#selector')           detailed child/attribute log for one container
 *   __adProbe.verbose(true)                    log every non-segment request
 *   __adProbe.ignore(/pattern/)                stop logging requests matching a pattern (noisy trackers)
 *   __adProbe.download()                       save everything as JSON
 *   __adProbe.stop()                           remove all hooks
 */
(() => {
  if (window.__adProbe) window.__adProbe.stop();

  let active = true;
  const T0 = performance.now();
  const startedAt = new Date().toISOString();
  const events = [];
  const cleanup = [];
  const COLORS = { adtext: '#c2410c',  MARK: '#e11d48', manifest: '#2563eb', ad: '#d97706', track: '#b45309', player: '#4f46e5', tree: '#be123c', segment: '#059669', mse: '#7c3aed', dom: '#db2777', video: '#0891b2', cue: '#65a30d', watch: '#ea580c', probe: '#666' };
  const origLog = console.log.bind(console);

  const log = (type, data = {}) => {
    const e = { ...data, t: +((performance.now() - T0) / 1000).toFixed(2), at: new Date().toLocaleTimeString(), type };
    events.push(e);
    const group = type === 'MARK' ? 'MARK' : type.split('-')[0];
    origLog(`%c[adProbe ${e.t}s] ${type}`, `color:${COLORS[group] || '#666'};font-weight:bold`, data);
  };
  const short = (u, n = 140) => {
    try { const x = new URL(u, location.href); return (x.host + x.pathname).slice(0, n); }
    catch { return String(u).slice(0, n); }
  };
  const recent = new Map();
  const once = (key, ms = 3000) => {
    const now = performance.now(), p = recent.get(key);
    recent.set(key, now);
    return !p || now - p > ms;
  };

  /* ---------- 1. Manifest cue markers (fetch + XHR) ---------- */
  const MANIFEST_URL = /\.(m3u8|mpd)(\?|$)/i;
  const MANIFEST_CT = /mpegurl|dash\+xml/i;
  const MARKER_RE = /#EXT-X-CUE[^\n]*|#EXT-X-DATERANGE[^\n]*|#EXT-X-SCTE35[^\n]*|#EXT-OATCLS-SCTE35[^\n]*|#EXT-X-ASSET[^\n]*|#EXT-X-DISCONTINUITY[^\n]*|<EventStream[\s\S]*?<\/EventStream>|<Period\b[^>]*>/gi;
  const manifestSig = new Map();
  const manifestText = new Map();

  const scanManifest = (url, text) => {
    if (!active || typeof text !== 'string' || !text) return;
    const key = short(url);
    manifestText.set(key, text.slice(0, 200000));
    const raw = text.match(MARKER_RE) || [];
    const counts = {};
    raw.forEach(m => {
      const k = m.replace(/\d+(\.\d+)?/g, '#').slice(0, 160); // normalise so sliding windows don't spam
      counts[k] = (counts[k] || 0) + 1;
    });
    const sig = JSON.stringify(Object.entries(counts).sort());
    const prev = manifestSig.get(key);
    if (prev === sig) return;
    manifestSig.set(key, sig);
    log(prev === undefined ? 'manifest-first' : 'manifest-changed', {
      file: key,
      markers: counts,
      samples: [...new Set(raw)].slice(0, 6).map(s => s.slice(0, 200)),
    });
  };

  /* VAST responses: ad durations + tracking URLs (so we can spot the "complete" beacon later) */
  const VAST_URL = /\/vast\b/i;
  const vastResponses = [];
  const vastTrackers = []; // { event, prefix }
  const addTracker = (event, raw) => {
    const url = (raw || '').trim();
    if (!/^https?:/i.test(url)) return;
    const prefix = url.split('[')[0].split('%%')[0].split('{')[0].slice(0, 120); // stop at macros
    if (prefix.length > 15 && !vastTrackers.some(x => x.prefix === prefix && x.event === event)) vastTrackers.push({ event, prefix });
  };
  const scanVast = (url, text) => {
    if (!active || typeof text !== 'string' || !text) return;
    vastResponses.push({ at: new Date().toLocaleTimeString(), url: short(url), text: text.slice(0, 200000) });
    const out = { url: short(url), bytes: text.length };
    if (/<VAST|<Ad[\s>]/i.test(text)) {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const tags = (el, name) => [...el.getElementsByTagName(name)];
      out.ads = tags(doc, 'Ad').map(ad => {
        tags(ad, 'Impression').forEach(n => addTracker('impression', n.textContent));
        tags(ad, 'Tracking').forEach(n => addTracker(n.getAttribute('event') || 'tracking', n.textContent));
        return {
          id: ad.getAttribute('id') || undefined,
          seq: ad.getAttribute('sequence') || undefined,
          title: (tags(ad, 'AdTitle')[0]?.textContent || '').trim().slice(0, 60) || undefined,
          duration: (tags(ad, 'Duration')[0]?.textContent || '').trim() || undefined,
          events: [...new Set(tags(ad, 'Tracking').map(n => n.getAttribute('event')))].join(','),
          hosts: [...new Set([...tags(ad, 'Impression'), ...tags(ad, 'Tracking')].map(n => { try { return new URL(n.textContent.trim()).host; } catch { return null; } }).filter(Boolean))].join(','),
        };
      });
      out.summary = out.ads.map(a => `${a.seq || '-'}:${a.duration || '?'} ${a.title || a.id || ''}`.trim()).join(' | ');
      if (tags(doc, 'VASTAdTagURI').length) out.wrapper = true;
      if (!out.ads.length) out.empty = true;
    } else {
      out.durations = (text.match(/"?duration\w*"?\s*[:=]\s*"?[\d:.]+/gi) || []).slice(0, 10);
      out.preview = text.slice(0, 300);
    }
    log('vast-response', out);
  };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    try { if (init && init.body) logBatch(url, init.body); } catch {}
    const p = origFetch.apply(window, arguments);
    p.then(r => {
      const ct = r.headers.get('content-type') || '';
      if (VAST_URL.test(url) || VAST_URL.test(r.url)) r.clone().text().then(t => scanVast(r.url || url, t)).catch(() => {});
      if (MANIFEST_URL.test(url) || MANIFEST_URL.test(r.url) || MANIFEST_CT.test(ct)) {
        r.clone().text().then(t => scanManifest(r.url || url, t)).catch(() => {});
      }
    }).catch(() => {});
    return p;
  };
  cleanup.push(() => { window.fetch = origFetch; });

  // Request bodies that mention ads (many players batch telemetry into POSTs)
  const logBatch = (url, body) => {
    if (!active || body == null) return;
    let text = '';
    try {
      text = typeof body === 'string' ? body
        : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? new TextDecoder().decode(body)
        : body instanceof URLSearchParams ? body.toString() : '';
    } catch {}
    if (!text || !/\bad(s|break|pod|id|start|end|complete|impression|insertion)?\b|advert/i.test(text)) return;
    const names = [...text.matchAll(/"(?:event_?name|eventName|event|name|type|eventType)"\s*:\s*"([^"]{1,60})"/gi)].map(m => m[1]);
    log('post-body', { url: short(url), names: [...new Set(names)].slice(0, 12).join(', ') || undefined, preview: text.slice(0, 300) });
  };

  const XP = XMLHttpRequest.prototype, XO = XP.open, XS = XP.send;
  XP.open = function (m, url) { this.__probeUrl = String(url); return XO.apply(this, arguments); };
  XP.send = function (body) {
    try { logBatch(this.__probeUrl || '', body); } catch {}
    this.addEventListener('load', () => {
      if (!active) return;
      try {
        const u = this.responseURL || this.__probeUrl;
        const ct = this.getResponseHeader('content-type') || '';
        const isVast = VAST_URL.test(u);
        if (!(isVast || MANIFEST_URL.test(u) || MANIFEST_CT.test(ct))) return;
        const rt = this.responseType;
        const text = rt === '' || rt === 'text' ? this.responseText
          : rt === 'arraybuffer' ? new TextDecoder().decode(this.response)
          : rt === 'document' && this.responseXML ? new XMLSerializer().serializeToString(this.responseXML)
          : rt === 'json' ? JSON.stringify(this.response) : null;
        if (isVast) scanVast(u, text); else scanManifest(u, text);
      } catch {}
    });
    return XS.apply(this, arguments);
  };
  cleanup.push(() => { XP.open = XO; XP.send = XS; });

  /* ---------- 2. Ad-ish requests + segment path changes (Resource Timing) ---------- */
  const AD_URL = /(^|[\/._?&=-])(ads?|adserver|adtech|adsystem|amazon-adsystem|aax|adbreak|adbreaks|adpod|advert\w*|pagead|googleads|vast|vmap|impressions?|beacons?|pixel|doubleclick|googlesyndication|moatads|adsafeprotected|scte35?|sponsor\w*|cuepoints?)(?=[\/._?&=-]|$)/i;
  // Marketing/retargeting pixels that fire on page load or on a timer, unrelated to ad breaks
  const AD_IGNORE_BASE = /quora\.com|twitter\.com|ads-twitter|\/\/t\.co\/|facebook\.(com|net)\/tr|fls\.doubleclick|stats\.g\.doubleclick|googleads\.g\.doubleclick|ad\.doubleclick\.net\/(ccm|activity)|google\.[a-z.]+\/(ccm|pagead|ads\/ga-audiences)|google-analytics\.com|googletagmanager\.com/i;
  const extraIgnore = [];
  const AD_IGNORE = { test: u => AD_IGNORE_BASE.test(u) || extraIgnore.some(re => re.test(u)) };
  const SEGMENT = /\.(ts|m4s|m4v|m4a|mp4|aac|cmfv|cmfa)$|\/(seg|segment|chunk|frag)[^/]*$/i;
  const segSeen = new Map();
  let adWindowUntil = 0;
  let verboseOn = false;

  const trackSegment = u => {
    let x; try { x = new URL(u); } catch { return false; }
    if (!SEGMENT.test(x.pathname)) return false;
    const sig = x.host + x.pathname.replace(/[^/]+$/, '').replace(/\d+/g, '#');
    const now = performance.now(), prev = segSeen.get(sig);
    if (!prev) log('segment-path-new', { sig, sample: short(u) });
    else if (now - prev > 10000) log('segment-path-resumed', { sig, gapS: +((now - prev) / 1000).toFixed(1) });
    segSeen.set(sig, now);
    return true;
  };

  try { performance.setResourceTimingBufferSize(5000); } catch {}
  const po = new PerformanceObserver(list => {
    if (!active) return;
    for (const r of list.getEntries()) {
      const u = r.name;
      const isSeg = trackSegment(u);
      if (isSeg) continue;
      const hit = vastTrackers.find(x => u.startsWith(x.prefix));
      if (hit) {
        log('vast-tracker', { event: hit.event, url: u.slice(0, 160) });
      } else if (AD_URL.test(u) && !AD_IGNORE.test(u) && once('ad:' + short(u))) {
        log('ad-url', { url: short(u), via: r.initiatorType });
      } else if ((verboseOn || performance.now() < adWindowUntil) && !AD_IGNORE.test(u) && once('net:' + short(u))) {
        // everything else for 2 min after an ad appears: looking for what fires at its start and end
        log('net-in-ad', { url: u.slice(0, 160), via: r.initiatorType });
      }
    }
  });
  po.observe({ type: 'resource', buffered: true });
  cleanup.push(() => po.disconnect());

  /* ---------- 3. MSE: new buffers, codec switches, timestamp offsets ---------- */
  if (window.MediaSource) {
    const MS = MediaSource.prototype, origASB = MS.addSourceBuffer;
    MS.addSourceBuffer = function (mime) { log('mse-addSourceBuffer', { mime }); return origASB.apply(this, arguments); };
    cleanup.push(() => { MS.addSourceBuffer = origASB; });
  }
  if (window.SourceBuffer) {
    const SB = SourceBuffer.prototype;
    const d = Object.getOwnPropertyDescriptor(SB, 'timestampOffset');
    const lastOff = new WeakMap();
    if (d && d.set) {
      Object.defineProperty(SB, 'timestampOffset', {
        configurable: true, enumerable: d.enumerable,
        get() { return d.get.call(this); },
        set(v) {
          if (active && lastOff.get(this) !== v) {
            log('mse-timestampOffset', { from: lastOff.get(this), to: v });
            lastOff.set(this, v);
          }
          d.set.call(this, v);
        },
      });
      cleanup.push(() => Object.defineProperty(SB, 'timestampOffset', d));
    }
    const origCT = SB.changeType;
    if (origCT) {
      SB.changeType = function (t) { if (active) log('mse-changeType', { type: t }); return origCT.apply(this, arguments); };
      cleanup.push(() => { SB.changeType = origCT; });
    }
  }

  /* ---------- 4. DOM: ad-ish elements appearing / showing / hiding ---------- */
  const AD_DOM = /\b(ads?|advert\w*|sponsor\w*|skip|countdown|commercial|ad ?timer|ad ?time ?indicator|ad ?break|ad ?badge|ad ?label)\b/i;
  const AD_TEXT = /^\s*(ad|ads|advertisement|sponsored)\b|\bad\s*\d+\s*(of|\/)\s*\d+|\bads?\s*[\u00b7|:-]?\s*\d+:\d{2}/i;
  const tracked = new Map();
  const norm = s => (s || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  const describe = el => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || undefined,
    cls: (el.getAttribute('class') || '').slice(0, 120) || undefined,
    aria: el.getAttribute('aria-label') || undefined,
    testid: el.getAttribute('data-testid') || undefined,
    text: textOf(el).slice(0, 60) || undefined,
  });
  // Text with spaces between child nodes ("Ad" "1 of 2" "0:24" -> "Ad 1 of 2 0:24", not "Ad1 of 20:24")
  const textOf = el => {
    const parts = [];
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (w.nextNode() && parts.length < 40) { const t = w.currentNode.textContent.trim(); if (t) parts.push(t); }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  };
  const ownText = el => [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join(' ').trim();
  const matches = el => {
    const leafText = el.childElementCount === 0 ? (el.textContent || '').trim().slice(0, 80) : '';
    if (AD_TEXT.test(ownText(el).slice(0, 80)) || AD_TEXT.test(leafText)) return true;
    return AD_DOM.test(norm([el.id, el.getAttribute('class'), el.getAttribute('aria-label'), el.getAttribute('data-testid'), leafText].join(' ')));
  };
  // Ad-ish class names on an element that stays on screen (e.g. YouTube adds "ad-showing" to the player)
  const AD_CLASS = /(^|[\s_-])(ad|ads|advert\w*|ad-?showing|ad-?playing|ad-?break|ad-?interrupting|ima-ad|sponsored)([\s_-]|$)/i;
  const classTokens = new WeakMap();
  const adTokens = el => (el.getAttribute && (el.getAttribute('class') || '').split(/\s+/).filter(c => c && AD_CLASS.test(c))) || [];
  const checkClass = el => {
    if (!el || el.nodeType !== 1) return;
    const now = adTokens(el), before = classTokens.get(el) || [];
    const added = now.filter(c => !before.includes(c)), removed = before.filter(c => !now.includes(c));
    if (added.length || removed.length) {
      classTokens.set(el, now);
      if (before.length || now.length) {
        log('dom-class', { tag: el.tagName.toLowerCase(), id: el.id || undefined, added: added.join(' ') || undefined, removed: removed.join(' ') || undefined });
        if (added.length) adWindowUntil = performance.now() + 120000;
      }
    }
  };

  const consider = el => {
    if (!el || el.nodeType !== 1 || tracked.has(el) || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;
    if (!matches(el)) return;
    const d = describe(el);
    tracked.set(el, { vis: null, d });
    if (once('dom:' + JSON.stringify(d))) log('dom-added', d);
  };
  const isVisible = el => {
    if (!el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity > 0.05;
  };

  document.querySelectorAll('body *').forEach(el => { consider(el); const t = adTokens(el); if (t.length) classTokens.set(el, t); });
  const mo = new MutationObserver(muts => {
    if (!active) return;
    for (const m of muts) {
      if (m.type === 'childList') {
        m.addedNodes.forEach(n => {
          if (n.nodeType === 1) {
            consider(n);
            if (n.childElementCount) [...n.querySelectorAll('*')].slice(0, 300).forEach(consider);
          } else if (n.nodeType === 3) consider(n.parentElement);
        });
      } else if (m.type === 'attributes') { consider(m.target); if (m.attributeName === 'class') checkClass(m.target); }
      else if (m.type === 'characterData') consider(m.target.parentElement);
    }
  });
  mo.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'id', 'aria-label', 'data-testid'],
  });
  cleanup.push(() => mo.disconnect());

  const watchers = [];
  const adTextLog = [];
  const domPoll = setInterval(() => {
    if (!active) return;
    for (const [el, s] of tracked) {
      if (!el.isConnected) {
        if (s.vis) log('dom-removed', s.d);
        tracked.delete(el);
        continue;
      }
      const v = isVisible(el);
      if (v !== s.vis) {
        if (v) {
          s.d = describe(el);
          log('dom-visible', s.d);
          if (AD_TEXT.test(s.d.text || '')) adWindowUntil = performance.now() + 120000;
        }
        else if (s.vis !== null) log('dom-hidden', { ...s.d, lastText: s.lastText });
        s.vis = v;
      }
      if (v) {
        // Ad countdowns ("Ad 0:24", "Ad 1 of 2"): log when the text changes shape, or every 5s
        const text = textOf(el).slice(0, 80);
        if (text && text !== s.lastText && AD_TEXT.test(text)) {
          const now = performance.now();
          const shape = text.replace(/\d/g, '#');
          if (shape !== s.lastShape || !s.lastTextAt || now - s.lastTextAt > 5000) {
            const mm = text.match(/(\d+):(\d{2})/);
            log('adtext', { text, remainingS: mm ? +mm[1] * 60 + +mm[2] : undefined, cls: s.d.cls, tag: s.d.tag });
            adTextLog.push({ t: +((now - T0) / 1000).toFixed(2), text, cls: s.d.cls });
            s.lastShape = shape;
            s.lastTextAt = now;
          }
          s.lastText = text;
        }
      }
    }
    for (const w of watchers) {
      const el = document.querySelector(w.selector);
      const on = !!el && isVisible(el);
      if (on !== w.on) {
        log(on ? 'watch-on' : 'watch-off', { label: w.label, text: el ? (el.textContent || '').trim().slice(0, 60) : undefined });
        w.on = on;
      }
    }
  }, 500);
  cleanup.push(() => clearInterval(domPoll));

  // Detailed watcher for a specific container: children added/removed, class/style/src changes
  const watchTree = selector => {
    const attach = () => {
      const root = document.querySelector(selector);
      if (!root) return false;
      const tag = el => el === root ? '(root)' : el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
      const mo2 = new MutationObserver(muts => {
        if (!active) return;
        for (const m of muts) {
          if (m.type === 'childList') {
            m.addedNodes.forEach(n => n.nodeType === 1 && log('tree-added', { root: selector, parent: tag(m.target), ...describe(n) }));
            m.removedNodes.forEach(n => n.nodeType === 1 && log('tree-removed', { root: selector, parent: tag(m.target), ...describe(n) }));
          } else if (m.type === 'attributes') {
            const value = String(m.target.getAttribute(m.attributeName) || '').slice(0, 160);
            if (once(`tree:${tag(m.target)}:${m.attributeName}:${value}`, 1000)) {
              log('tree-attr', { root: selector, el: tag(m.target), attr: m.attributeName, value });
            }
          }
        }
      });
      mo2.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'src', 'hidden', 'aria-hidden'] });
      cleanup.push(() => mo2.disconnect());
      const r = root.getBoundingClientRect();
      log('tree-watching', { selector, children: root.childElementCount, visible: isVisible(root), size: `${Math.round(r.width)}x${Math.round(r.height)}` });
      watchers.push({ selector, label: selector, on: null });
      return true;
    };
    if (!attach()) {
      const iv = setInterval(() => { if (!active || attach()) clearInterval(iv); }, 1000);
      cleanup.push(() => clearInterval(iv));
    }
  };

  /* ---------- 5. <video> state, resolution changes, time jumps, metadata cues ---------- */
  const videos = new Map();
  const VEVENTS = ['loadedmetadata', 'emptied', 'resize', 'waiting', 'playing', 'pause', 'volumechange', 'ratechange', 'seeking', 'seeked', 'error'];
  const vinfo = v => ({
    res: `${v.videoWidth}x${v.videoHeight}`,
    vt: +v.currentTime.toFixed(2),
    muted: v.muted, vol: +v.volume.toFixed(2), paused: v.paused,
    dur: Number.isFinite(v.duration) ? +v.duration.toFixed(1) : String(v.duration),
    src: (v.currentSrc || '').slice(0, 60),
  });
  const cueValue = val => {
    if (!val) return undefined;
    const data = val.data instanceof ArrayBuffer ? new TextDecoder().decode(val.data) : JSON.stringify(val.data ?? val);
    return ((val.key ? val.key + ': ' : '') + data).slice(0, 200);
  };
  const hookVideo = v => {
    if (videos.has(v)) return;
    let pausedAt = null;
    const off = VEVENTS.map(ev => {
      const h = () => {
        if (!active) return;
        const extra = {};
        if (ev === 'pause') pausedAt = performance.now();
        if (ev === 'playing' && pausedAt) { extra.pauseGapMs = Math.round(performance.now() - pausedAt); pausedAt = null; }
        log('video-' + ev, { ...vinfo(v), ...extra });
      };
      v.addEventListener(ev, h);
      return () => v.removeEventListener(ev, h);
    });
    const hookTracks = () => {
      for (const tr of v.textTracks) {
        if (tr.__probe) continue;
        tr.__probe = true;
        log('cue-track', { kind: tr.kind, label: tr.label, lang: tr.language });
        if (tr.kind === 'metadata' && tr.mode === 'disabled') tr.mode = 'hidden'; // needed to receive cues
        tr.addEventListener('cuechange', () => {
          if (!active) return;
          const cues = [...(tr.activeCues || [])].map(c => ({
            start: c.startTime, end: c.endTime,
            text: c.text ? c.text.slice(0, 200) : undefined,
            value: cueValue(c.value),
          }));
          if (cues.length) log('cue-active', { kind: tr.kind, label: tr.label, cues });
        });
      }
    };
    hookTracks();
    v.textTracks.addEventListener('addtrack', hookTracks);
    off.push(() => v.textTracks.removeEventListener('addtrack', hookTracks));
    videos.set(v, { lastT: v.currentTime, lastW: performance.now(), off });
    log('video-found', vinfo(v));
  };
  const videoPoll = setInterval(() => {
    if (!active) return;
    document.querySelectorAll('video').forEach(hookVideo);
    const now = performance.now();
    for (const [v, s] of videos) {
      if (!v.isConnected) { log('video-detached', {}); s.off.forEach(f => f()); videos.delete(v); continue; }
      const expected = ((now - s.lastW) / 1000) * (v.paused ? 0 : v.playbackRate);
      const actual = v.currentTime - s.lastT;
      if (!v.seeking && v.readyState >= 3 && Math.abs(actual - expected) > 2) {
        log('video-timejump', { from: +s.lastT.toFixed(2), to: +v.currentTime.toFixed(2), expectedDelta: +expected.toFixed(2) });
      }
      s.lastT = v.currentTime;
      s.lastW = now;
    }
  }, 1000);
  cleanup.push(() => { clearInterval(videoPoll); for (const s of videos.values()) s.off.forEach(f => f()); });

  /* ---------- 6. Google IMA SDK (used by many sites for client-side ads) ---------- */
  let imaHooked = false;
  const hookIma = () => {
    const ima = window.google && window.google.ima;
    if (imaHooked || !ima || !ima.AdsManagerLoadedEvent || !ima.AdEvent) return;
    imaHooked = true;
    log('ima-found', { version: ima.VERSION || undefined });
    const proto = ima.AdsManagerLoadedEvent.prototype;
    const orig = proto.getAdsManager;
    const types = Object.values(ima.AdEvent.Type || {});
    proto.getAdsManager = function () {
      const mgr = orig.apply(this, arguments);
      try {
        for (const type of types) {
          mgr.addEventListener(type, ev => {
            if (!active) return;
            let ad = null;
            try { ad = ev.getAd && ev.getAd(); } catch {}
            log('ima-event', {
              type,
              adId: ad && ad.getAdId ? ad.getAdId() : undefined,
              title: ad && ad.getTitle ? String(ad.getTitle()).slice(0, 60) : undefined,
              duration: ad && ad.getDuration ? ad.getDuration() : undefined,
              pod: ad && ad.getAdPodInfo ? `${ad.getAdPodInfo().getAdPosition()}/${ad.getAdPodInfo().getTotalAds()}` : undefined,
            });
            if (type === 'start' || type === 'loaded') adWindowUntil = performance.now() + 120000;
          });
        }
        log('ima-manager', { listeningTo: types.length });
      } catch (e) { log('ima-error', { message: String(e) }); }
      return mgr;
    };
    cleanup.push(() => { proto.getAdsManager = orig; });
  };
  hookIma();
  const imaPoll = setInterval(() => { if (active && !imaHooked) hookIma(); }, 1000);
  cleanup.push(() => clearInterval(imaPoll));

  /* ---------- 7. Manual markers ---------- */
  const onKey = e => {
    if (!e.altKey || e.repeat) return;
    if (e.code === 'KeyA') { log('MARK', { label: 'ad on screen' }); adWindowUntil = performance.now() + 120000; }
    if (e.code === 'KeyM') log('MARK', { label: 'show back' });
  };
  window.addEventListener('keydown', onKey, true);
  cleanup.push(() => window.removeEventListener('keydown', onKey, true));

  /* ---------- API ---------- */
  window.__adProbe = {
    events,
    manifests: manifestText,
    vast: vastResponses,
    vastTrackers,
    verbose: (on = true) => { verboseOn = on; log('probe-verbose', { on }); },
    mark: (label = 'mark') => { log('MARK', { label }); if (/\bad\b/i.test(label)) adWindowUntil = performance.now() + 120000; },
    adText: () => console.table(adTextLog),
    ignore: re => { extraIgnore.push(re instanceof RegExp ? re : new RegExp(String(re).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')); log('probe-ignore', { pattern: String(re) }); },
    // Which signals line up with your marks. For each signal type: how many "ad on screen" and "show back" marks
    // it appeared within ±windowS seconds of, and its median offset (negative = before your mark).
    report: (windowS = 6) => {
      const marks = events.filter(e => e.type === 'MARK');
      const kind = m => /back|resum|end/i.test(m.label) ? 'end' : /\bad\b|start/i.test(m.label) ? 'start' : null;
      const starts = marks.filter(m => kind(m) === 'start'), ends = marks.filter(m => kind(m) === 'end');
      if (!starts.length && !ends.length) { console.warn('No marks yet. Use Option+A / Option+M or __adProbe.mark() during a few ad breaks.'); return; }
      const noise = /^(MARK|probe-|segment-path-new|video-found|cue-track|watch-added|tree-watching|ima-found|ima-manager)/;
      const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.floor(s.length / 2)].toFixed(2) : undefined; };
      const near = (group, type) => {
        const offsets = [];
        for (const m of group) {
          const hits = events.filter(e => e.type === type && Math.abs(e.t - m.t) <= windowS);
          if (hits.length) offsets.push(hits.reduce((best, e) => Math.abs(e.t - m.t) < Math.abs(best) ? e.t - m.t : best, Infinity));
        }
        return offsets;
      };
      const types = [...new Set(events.map(e => e.type))].filter(t => !noise.test(t));
      const rows = types.map(type => {
        const s = near(starts, type), e = near(ends, type);
        return {
          signal: type,
          'near ad start': starts.length ? `${s.length}/${starts.length}` : '-',
          'start offset s': median(s),
          'near show back': ends.length ? `${e.length}/${ends.length}` : '-',
          'end offset s': median(e),
          'total events': events.filter(x => x.type === type).length,
          score: (starts.length ? s.length / starts.length : 0) + (ends.length ? e.length / ends.length : 0),
        };
      }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || a['total events'] - b['total events']);
      console.log(`%cSignals near your marks (${starts.length} ad starts, ${ends.length} show-backs, ±${windowS}s). ` +
        'Best candidates appear near every mark, with few total events.', 'font-weight:bold');
      console.table(rows.map(({ score, ...r }) => r));
      return rows;
    },
    watchTree,
    watch: (selector, label = selector) => { watchers.push({ selector, label, on: null }); log('watch-added', { selector, label }); },
    summary: prefix => console.table(
      events
        .filter(e => !prefix || e.type.startsWith(prefix))
        .map(({ t, at, type, ...rest }) => ({ t, at, type, detail: JSON.stringify(rest).slice(0, 160) }))
    ),
    download: () => {
      const blob = new Blob([JSON.stringify({ page: location.href, startedAt, events, adText: adTextLog, vast: vastResponses, vastTrackers, manifests: Object.fromEntries(manifestText) }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `adprobe-${location.hostname}-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },
    stop: () => {
      active = false;
      cleanup.forEach(f => { try { f(); } catch {} });
      log('probe-stopped', { events: events.length });
      delete window.__adProbe;
    },
  };

  log('probe-started', { page: location.href, videos: document.querySelectorAll('video').length, domCandidates: tracked.size });
})();
