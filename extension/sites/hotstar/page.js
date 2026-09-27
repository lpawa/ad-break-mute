// JioHotstar detection. Runs in the page's own context (world: MAIN) at document_start,
// before the player loads. Translates Hotstar's signals into the core's events:
//   break    - the VAST response announcing upcoming ads, with each ad's duration
//   ad-start - the ct_impression beacon the player fires as each ad starts
// Hotstar has no ad-end signal, so the core ends each ad on a timer.
(() => {
  if (window.__adBreakMuteHotstar) return;
  window.__adBreakMuteHotstar = true;

  const emit = detail => document.dispatchEvent(new CustomEvent('ad-break-mute', { detail: JSON.stringify(detail) }));

  const VAST_URL = /\/vast\b/i;
  const IMPRESSION = /bifrost-api\.hotstar\.com\/v\d+\/events\/track\/ct_impression/i;
  const NON_VIDEO = /display|banner|image|static|overlay|native/i;
  const announced = new Set(); // ad titles seen in VAST responses

  /* ---------- VAST: which ads are coming, and how long each is ---------- */
  const parseDuration = s => { // "00:00:30.017" -> 30.017
    const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s || '');
    return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : null;
  };
  const scanVast = text => {
    if (typeof text !== 'string' || !/<VAST|<Ad[\s>]/i.test(text)) return;
    try {
      const doc = new DOMParser().parseFromString(text, 'text/xml');
      const ads = [...doc.getElementsByTagName('Ad')]
        .map(ad => ({
          name: (ad.getElementsByTagName('AdTitle')[0]?.textContent || '').trim() || ad.getAttribute('id') || '',
          seconds: parseDuration(ad.getElementsByTagName('Duration')[0]?.textContent),
        }))
        .filter(a => a.seconds);
      ads.forEach(a => announced.add(a.name));
      if (ads.length) emit({ kind: 'break', ads });
    } catch {}
  };

  /* ---------- ct_impression: an ad just started ---------- */
  const seen = new Set();
  const checkImpression = (raw, via) => {
    if (!raw || !IMPRESSION.test(raw)) return;
    let u;
    try { u = new URL(raw, location.href); } catch { return; }
    if (seen.has(u.href)) return;
    seen.add(u.href);
    if (seen.size > 500) seen.clear();
    const q = u.searchParams;
    const name = q.get('adName') || '';
    const creativeType = q.get('creative_type') || '';
    const isAnnounced = [...announced].some(t => t && name && (t === name || t.startsWith(name) || name.startsWith(t)));
    if (!isAnnounced && NON_VIDEO.test(creativeType)) {
      emit({ kind: 'skip', name, reason: `non-video impression (${creativeType})` });
      return;
    }
    emit({ kind: 'ad-start', name, via, meta: { creativeType } });
  };

  // Catch the beacon when the player creates it (image src / fetch / sendBeacon)...
  const imgSrc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgSrc && imgSrc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true, enumerable: imgSrc.enumerable,
      get() { return imgSrc.get.call(this); },
      set(v) { try { checkImpression(String(v), 'img'); } catch {} imgSrc.set.call(this, v); },
    });
  }
  const origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLImageElement && String(name).toLowerCase() === 'src') {
      try { checkImpression(String(value), 'img'); } catch {}
    }
    return origSetAttribute.apply(this, arguments);
  };
  if (navigator.sendBeacon) {
    const origBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { try { checkImpression(String(url), 'beacon'); } catch {} return origBeacon(url, data); };
  }
  // ...and as a fallback, when the request completes.
  new PerformanceObserver(list => {
    for (const e of list.getEntries()) checkImpression(e.name, 'completed-request');
  }).observe({ type: 'resource', buffered: false });

  /* ---------- Diagnostics: ad markers in the live manifest, if any ---------- */
  const MANIFEST_CT = /mpegurl|dash\+xml/i;
  const MANIFEST_URL = /\.(m3u8|mpd)(\?|$)/i;
  const MARKER_RE = /#EXT-X-CUE[^\n]*|#EXT-X-DATERANGE[^\n]*|#EXT-X-SCTE35[^\n]*|#EXT-OATCLS-SCTE35[^\n]*|#EXT-X-ASSET[^\n]*|#EXT-X-DISCONTINUITY(?!-SEQUENCE)[^\n]*|<EventStream[\s\S]*?<\/EventStream>|<Period\b[^>]*>/gi;
  const manifestSig = new Map();
  const scanManifest = (url, text) => {
    if (typeof text !== 'string' || !/^\s*(#EXTM3U|<\?xml|<MPD)/i.test(text)) return;
    let key = url;
    try { const x = new URL(url, location.href); key = x.host + x.pathname; } catch {}
    const raw = text.match(MARKER_RE) || [];
    const counts = {};
    for (const m of raw) {
      const k = m.replace(/\d+(\.\d+)?/g, '#').slice(0, 160);
      counts[k] = (counts[k] || 0) + 1;
    }
    const sig = JSON.stringify(Object.entries(counts).sort());
    const prev = manifestSig.get(key);
    if (prev === sig) return;
    manifestSig.set(key, sig);
    const v = document.querySelector('video');
    const n = raw.length;
    emit({
      kind: 'debug',
      label: `Stream ${prev === undefined ? 'manifest seen' : 'markers changed'} (${/#EXTM3U/.test(text) ? 'HLS' : 'DASH'}, ${n} marker${n === 1 ? '' : 's'})`,
      data: { file: key.slice(-60), markers: counts, samples: [...new Set(raw)].slice(-4).map(m => m.slice(0, 240)), playhead: v ? +v.currentTime.toFixed(2) : null },
    });
  };

  /* ---------- Network hooks ---------- */
  const XP = XMLHttpRequest.prototype;
  const origOpen = XP.open, origSend = XP.send;
  XP.open = function (method, url) {
    this.__abmUrl = String(url);
    return origOpen.apply(this, arguments);
  };
  XP.send = function () {
    this.addEventListener('load', () => {
      try {
        const u = this.responseURL || this.__abmUrl || '';
        const isVast = VAST_URL.test(u);
        const isManifest = MANIFEST_CT.test(this.getResponseHeader('content-type') || '') || MANIFEST_URL.test(u);
        if (!isVast && !isManifest) return;
        const rt = this.responseType;
        const text = rt === '' || rt === 'text' ? this.responseText
          : rt === 'document' && this.responseXML ? new XMLSerializer().serializeToString(this.responseXML)
          : rt === 'arraybuffer' ? new TextDecoder().decode(this.response) : null;
        if (isVast) scanVast(text); else scanManifest(u, text);
      } catch {}
    });
    return origSend.apply(this, arguments);
  };

  const origFetch = window.fetch;
  window.fetch = function (input) {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    try { checkImpression(url, 'fetch'); } catch {}
    const p = origFetch.apply(window, arguments);
    p.then(r => {
      const u = r.url || url;
      if (VAST_URL.test(url) || VAST_URL.test(u)) r.clone().text().then(scanVast).catch(() => {});
      else if (MANIFEST_CT.test(r.headers.get('content-type') || '') || MANIFEST_URL.test(u)) {
        r.clone().text().then(t => scanManifest(u, t)).catch(() => {});
      }
    }).catch(() => {});
    return p;
  };
})();
