/* Prime Video ad-break probe
 * Paste into the DevTools CONSOLE on primevideo.com (or amazon.com/gp/video) once something with ads is playing.
 * Logs every signal that might indicate an ad: the on-screen ad countdown, ad requests and beacons,
 * DASH/HLS manifest markers, and the video element, so you can see which one lines up with the ads.
 *
 *   Option+A (Alt+A) -> mark "ad on screen"   (click the video first so the page has focus)
 *   Option+M (Alt+M) -> mark "show back"
 *   __adProbe.mark('anything')                 custom marker (works from the Console, no focus needed)
 *   __adProbe.summary() / summary('dom')       compact table of events (optional type prefix filter)
 *   __adProbe.adText()                         every ad-looking text seen on screen, with timestamps
 *   __adProbe.watch('.selector', 'label')      track visibility of an element you found
 *   __adProbe.watchTree('#selector')           detailed child/attribute log for one container
 *   __adProbe.verbose(true)                    log every non-segment request
 *   __adProbe.download()                       save everything as JSON (send me this)
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

  // Request bodies that mention ads (Prime batches player telemetry into POSTs)
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
  const AD_IGNORE = /quora\.com|twitter\.com|ads-twitter|\/\/t\.co\/|fls\.doubleclick|stats\.g\.doubleclick|googleads\.g\.doubleclick|ad\.doubleclick\.net\/(ccm|activity)|google\.[a-z.]+\/(ccm|pagead|ads\/ga-audiences)/i;
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

  document.querySelectorAll('body *').forEach(consider);
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
      } else if (m.type === 'attributes') consider(m.target);
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

  /* ---------- 6. Manual markers ---------- */
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
      a.download = `prime-adprobe-${Date.now()}.json`;
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
