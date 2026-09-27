// Ad Break Mute core (isolated content script). Site-agnostic: a site module
// (sites/<id>/page.js) reports ad events, and sites/<id>/site.js describes the site.
// This file decides when to mute and for how long, draws the countdown, keeps stats,
// and raises the "back" alert.
//
// Events from page.js, as JSON in a CustomEvent('ad-break-mute'):
//   { kind: 'break',    ads: [{ name, seconds }] }          ads announced ahead of time
//   { kind: 'ad-start', name, seconds?, via?, meta? }       an ad started (seconds optional)
//   { kind: 'ad-progress', remaining }                      seconds left, from an on-screen countdown
//   { kind: 'ad-end' }                                      an ad ended (sites with hasEndSignal)
//   { kind: 'skip',     name, reason }                      site ignored something ad-like
//   { kind: 'debug',    label, data }                       diagnostics for the console
(() => {
  const SITE = globalThis.AdBreakSite;
  if (!SITE) return;

  const DEFAULTS = { enabled: true, extraSeconds: 1, fallbackSeconds: 30, overlay: true, alertWhenAway: true, speedThrough: true, speedRate: 8 };
  let settings = { ...DEFAULTS };
  chrome.storage.sync.get(DEFAULTS, s => { settings = s; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const k in changes) settings[k] = changes[k].newValue;
    if ('enabled' in changes && !settings.enabled) endAd('turned off');
    if ('overlay' in changes && !settings.overlay) Overlay.hide();
    if ('speedThrough' in changes && !settings.speedThrough) Speed.stop();
  });

  const log = (...args) => console.info(`%c[Ad Break Mute \u00b7 ${SITE.name}]`, 'color:#1f5c3f;font-weight:bold', ...args);
  // Anonymous usage events. The background worker drops them unless the user opted in.
  const track = event => send({ type: 'analytics', event: { site: SITE.id, ...event } });
  const send = msg => {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch {} // extension reloaded: old page context
  };
  const content = () => { try { return SITE.content(); } catch { return { id: location.pathname, title: document.title }; } };
  // What's playing: "match", "episode", "movie". Sites can vary it per title via content().noun
  const nounOf = c => (c && c.noun) || SITE.contentNoun || 'show';
  // Sites without ad names return '' and get no per-brand stats
  const adLabel = name => { try { return SITE.adLabel ? SITE.adLabel(name) || '' : ''; } catch { return ''; } };
  const adNoun = SITE.adNoun || 'ad';

  const fmt = s => {
    s = Math.round(s);
    if (s < 60) return `${s}s`;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return h ? `${h}h ${m}m` : r ? `${m}m ${r}s` : `${m}m`;
  };
  const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

  /* ---------- Stats (keyed "<site>:<content id>") ---------- */
  const EMPTY_STATS = { total: { ads: 0, seconds: 0 }, brands: {}, matches: {}, sites: {} };
  let stats = structuredClone(EMPTY_STATS);
  const migrate = s => {
    s = { ...structuredClone(EMPTY_STATS), ...s };
    s.sites = s.sites || {};
    for (const k of Object.keys(s.matches)) {
      if (k.includes(':')) continue; // v0.2 stored Hotstar ids without a site prefix
      s.matches['hotstar:' + k] = { site: 'hotstar', noun: 'match', ...s.matches[k] };
      delete s.matches[k];
    }
    if (!Object.keys(s.sites).length && s.total.ads) s.sites.hotstar = { ...s.total };
    return s;
  };
  chrome.storage.local.get({ stats: EMPTY_STATS }, r => {
    stats = migrate(r.stats);
    chrome.storage.local.set({ stats });
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.stats) stats = migrate(changes.stats.newValue || EMPTY_STATS);
  });

  const recordStats = (brand, seconds) => {
    const c = content();
    const { id, title } = c;
    const key = `${SITE.id}:${id}`;
    const m = stats.matches[key] || (stats.matches[key] = { site: SITE.id, noun: nounOf(c), adNoun, title, ads: 0, seconds: 0, brands: {} });
    m.title = title;
    m.noun = nounOf(c);
    m.ads += 1;
    m.seconds += seconds;
    if (brand) m.brands[brand] = (m.brands[brand] || 0) + 1;
    m.last = Date.now();
    stats.total.ads += 1;
    stats.total.seconds += seconds;
    if (brand) stats.brands[brand] = (stats.brands[brand] || 0) + 1;
    const site = stats.sites[SITE.id] || (stats.sites[SITE.id] = { ads: 0, seconds: 0 });
    site.ads += 1;
    site.seconds += seconds;
    const keys = Object.keys(stats.matches);
    if (keys.length > 30) {
      keys.sort((a, b) => (stats.matches[a].last || 0) - (stats.matches[b].last || 0));
      keys.slice(0, keys.length - 30).forEach(k => delete stats.matches[k]);
    }
    chrome.storage.local.set({ stats });
    return m;
  };

  const record = entry => {
    chrome.storage.local.get({ history: [] }, ({ history }) => {
      chrome.storage.local.set({ history: [entry, ...history].slice(0, 20) });
    });
  };

  /* ---------- Player helpers ---------- */
  const largestVideo = () => {
    let best = null, area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect(), a = r.width * r.height;
      if (a > area) { area = a; best = v; }
    }
    return best;
  };
  const playerMuted = () => { const v = largestVideo(); return !!v && (v.muted || v.volume === 0); };

  /* ---------- Speed through ads (sites with canSpeedThrough) ---------- */
  // Plays the ad at up to 16x while it's muted and covered, then restores the speed you had.
  // If the player keeps resetting the speed, it gives up and lets the ad play normally.
  const Speed = (() => {
    let v = null, prevRate = 1, target = 1, resets = 0, onRate = null;
    const apply = () => { try { v.playbackRate = target; } catch {} };

    function start() {
      if (!settings.speedThrough || !SITE.canSpeedThrough) return 1;
      const vid = largestVideo();
      if (!vid) return 1;
      target = Math.min(16, Math.max(1, +settings.speedRate || 8));
      if (v === vid && onRate) { apply(); return target; } // next ad in the same break
      stop();
      v = vid;
      prevRate = vid.playbackRate || 1;
      resets = 0;
      onRate = () => {
        if (!v || v.playbackRate === target) return;
        if (++resets > 5) {
          log('The player keeps resetting the speed, so this ad will play at normal speed');
          track({ e: 'speed-reset' });
          stop();
          return;
        }
        apply();
      };
      v.addEventListener('ratechange', onRate);
      apply();
      return target;
    }

    function stop() {
      if (!v) return;
      v.removeEventListener('ratechange', onRate);
      try { v.playbackRate = prevRate; } catch {}
      v = null;
      onRate = null;
    }

    const rate = () => (v ? v.playbackRate || 1 : 1);
    return { start, stop, rate };
  })();

  /* ---------- Countdown overlay ---------- */
  const Overlay = (() => {
    let host, root, els, raf = 0, endsAt = 0, length = 1, isHolding = false;

    const build = () => {
      host = document.createElement('div');
      host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
      root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `
        <style>
          :host { all: initial; }
          .wrap {
            position: absolute; inset: 0; container-type: size;
            display: grid; place-items: center; cursor: pointer;
            background: rgba(10, 30, 20, 0.94); color: #f3f6f2;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
            font-variant-numeric: tabular-nums; text-align: center;
            animation: in .18s ease-out;
          }
          @keyframes in { from { opacity: 0; } to { opacity: 1; } }
          @media (prefers-reduced-motion: reduce) { .wrap { animation: none; } .bar i { transition: none; } }
          .card { display: grid; justify-items: center; gap: 1.2cqh; padding: 4cqh 4cqw; }
          .label { font-size: clamp(12px, 3.4cqh, 26px); opacity: .75; margin: 0; }
          .n { font-size: clamp(44px, 30cqh, 260px); font-weight: 750; line-height: .9; letter-spacing: -0.04em; margin: 0; }
          .n small { font-size: .32em; font-weight: 600; letter-spacing: 0; margin-left: .06em; opacity: .8; }
          .brand { font-size: clamp(13px, 4cqh, 30px); font-weight: 600; margin: 1cqh 0 0; }
          .tally { font-size: clamp(11px, 2.8cqh, 20px); opacity: .7; margin: 0; }
          .hint { font-size: clamp(10px, 2.2cqh, 15px); opacity: .45; margin: 2cqh 0 0; }
          .bar { position: absolute; left: 0; right: 0; bottom: 0; height: max(4px, 1cqh); background: rgba(255,255,255,.08); }
          .bar i { display: block; height: 100%; background: #d9392f; transform-origin: left; transition: transform .25s linear; }
        </style>
        <div class="wrap" role="status" aria-live="polite">
          <div class="card">
            <p class="label" id="label"></p>
            <p class="n" id="nwrap"><span id="n">0</span><small>s</small></p>
            <p class="brand" id="brand"></p>
            <p class="tally" id="tally"></p>
            <p class="hint">Click to watch the ad instead</p>
          </div>
          <div class="bar"><i id="bar"></i></div>
        </div>`;
      const $ = id => root.getElementById(id);
      els = { label: $('label'), nwrap: $('nwrap'), n: $('n'), brand: $('brand'), tally: $('tally'), bar: $('bar') };
      root.querySelector('.wrap').addEventListener('click', () => { Speed.stop(); hide(); });
    };

    const frame = () => {
      const parent = document.fullscreenElement || document.body;
      if (!parent) { raf = requestAnimationFrame(frame); return; }
      if (host.parentNode !== parent) parent.appendChild(host);
      const v = largestVideo();
      const r = v && v.getBoundingClientRect();
      const box = r && r.width > 80 && r.height > 60 ? r : { left: 0, top: 0, width: innerWidth, height: innerHeight };
      host.style.left = box.left + 'px';
      host.style.top = box.top + 'px';
      host.style.width = box.width + 'px';
      host.style.height = box.height + 'px';
      if (!isHolding) {
        const left = Math.max(0, (endsAt - Date.now()) / 1000);
        els.n.textContent = Math.ceil(left);
        els.bar.style.transform = `scaleX(${Math.min(1, 1 - left / length)})`;
      }
      raf = requestAnimationFrame(frame);
    };

    const show = ({ endsAt: e, seconds, brand, tally }) => {
      if (!settings.overlay) return;
      if (!host) build();
      isHolding = false;
      els.label.textContent = SITE.backLabel || 'Back in';
      els.nwrap.style.display = '';
      endsAt = e;
      length = Math.max(1, seconds);
      els.brand.textContent = brand;
      els.tally.textContent = tally;
      cancelAnimationFrame(raf);
      frame();
    };

    const holding = () => {
      if (!host || !host.isConnected) return;
      isHolding = true;
      els.label.textContent = 'Another ad is up next';
      els.nwrap.style.display = 'none';
      els.brand.textContent = '';
      els.bar.style.transform = 'scaleX(1)';
    };

    function hide() {
      cancelAnimationFrame(raf);
      raf = 0;
      host?.remove();
    }

    const update = e => { if (!isHolding) endsAt = e; };

    return { show, hide, holding, update };
  })();

  /* ---------- "Back" alert ---------- */
  const chime = () => {
    try {
      const ctx = new AudioContext();
      const t0 = ctx.currentTime + 0.05;
      [659.25, 987.77].forEach((freq, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain(), t = t0 + i * 0.16;
        o.type = 'sine';
        o.frequency.value = freq;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.22, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(t);
        o.stop(t + 0.65);
      });
      setTimeout(() => ctx.close(), 1500);
    } catch {}
  };

  /* ---------- Ad lifecycle ---------- */
  const durations = new Map(); // announced ad name -> seconds
  const pending = new Map();   // announced ads that haven't started yet -> when announced
  const HOLD_MS = 3000;        // stay muted this long waiting for the next announced ad
  const END_SAFETY_S = 10;     // sites with an end signal: unmute anyway this long after the expected end
  let state = { muted: false, unmuteAt: 0, adName: '' };
  let timer = null;

  const findAnnounced = name => {
    if (!name) return null;
    if (durations.has(name)) return name;
    for (const t of durations.keys()) if (t && (t.startsWith(name) || name.startsWith(t))) return t;
    return null;
  };
  const morePending = () => {
    const now = Date.now();
    for (const [k, t] of pending) if (now - t > 180000) pending.delete(k);
    return pending.size > 0;
  };

  const startAd = ({ name = '', seconds, via, meta }) => {
    if (!settings.enabled) return;
    const announcedAs = findAnnounced(name);
    if (announcedAs) pending.delete(announcedAs);
    const known = seconds ?? (announcedAs ? durations.get(announcedAs) : null);
    const adSeconds = known ?? settings.fallbackSeconds;
    const speed = Speed.start();
    const muteSeconds = adSeconds / speed + settings.extraSeconds; // real seconds until the show is back
    const timerSeconds = SITE.hasEndSignal ? muteSeconds + END_SAFETY_S : muteSeconds;
    const brand = adLabel(name);

    clearTimeout(timer);
    state = { muted: true, unmuteAt: Date.now() + muteSeconds * 1000, adName: name };
    send({ type: 'set-mute', muted: true });
    timer = setTimeout(adTimerDone, timerSeconds * 1000);

    const m = recordStats(brand, adSeconds);
    const n = brand ? m.brands[brand] : 0;
    Overlay.show({
      endsAt: state.unmuteAt,
      seconds: muteSeconds,
      brand: n > 1 ? `${brand}, for the ${ordinal(n)} time` : brand,
      tally: `${adNoun[0].toUpperCase() + adNoun.slice(1)} ${m.ads} this ${m.noun}. ${fmt(m.seconds)} ${speed > 1 ? 'skipped' : 'muted'} so far.` +
        (speed > 1 ? ` Speeding through at ${speed}\u00d7.` : ''),
    });

    log(`Muted for ${muteSeconds.toFixed(1)}s`, { name, brand, knownDuration: known, speed, via, ...meta });
    track({ e: 'ad', secs: Math.round(adSeconds), known: known != null, via: via || '', speed, brand: brand || '' });
    record({ at: Date.now(), site: SITE.id, adName: name, brand, seconds: +muteSeconds.toFixed(1), fromVast: known != null });
  };

  // The ad's time is up. If more announced ads haven't started, the next one's start
  // signal can arrive a moment late, so stay muted briefly instead of unmuting into it.
  function adTimerDone() {
    if (morePending()) {
      state.unmuteAt = Date.now() + HOLD_MS;
      Overlay.holding();
      log(`Staying muted: ${pending.size} more ad(s) announced for this break`);
      timer = setTimeout(() => { pending.clear(); endAd('ad break over'); }, HOLD_MS);
      return;
    }
    endAd('ad finished');
  }

  function endAd(reason) {
    clearTimeout(timer);
    timer = null;
    Overlay.hide();
    Speed.stop();
    if (!state.muted) return;
    track({ e: 'end', reason });
    state = { muted: false, unmuteAt: 0, adName: '' };
    send({ type: 'set-mute', muted: false });
    log('Unmuted:', reason);
    const natural = reason === 'ad finished' || reason === 'ad break over' || reason === 'site reported ad end';
    if (natural && settings.alertWhenAway && document.hidden) {
      if (!playerMuted()) setTimeout(chime, 300); // after the tab is unmuted; none if you watch muted
      const c = content();
      send({ type: 'notify', title: SITE.backTitle || `Your ${nounOf(c)} is back`, message: c.title });
    }
  }

  document.addEventListener('ad-break-mute', e => {
    let d;
    try { d = JSON.parse(e.detail); } catch { return; }
    switch (d.kind) {
      case 'break':
        for (const a of d.ads || []) {
          if (!a.name) continue;
          durations.set(a.name, a.seconds);
          pending.set(a.name, Date.now());
          if (durations.size > 50) durations.delete(durations.keys().next().value);
        }
        log('Ad break coming:', (d.ads || []).map(a => `${a.name} (${a.seconds}s)`).join(', '));
        break;
      case 'ad-start':
        startAd(d);
        break;
      case 'ad-progress': {
        const remaining = Math.max(0, +d.remaining || 0);
        if (!state.muted) { startAd({ name: d.name || '', seconds: remaining, via: 'countdown (joined mid-ad)' }); break; }
        // Follow the site's countdown, so pausing mid-ad keeps the tab muted
        const real = remaining / Speed.rate();
        state.unmuteAt = Date.now() + (real + settings.extraSeconds) * 1000;
        Overlay.update(state.unmuteAt);
        clearTimeout(timer);
        timer = setTimeout(adTimerDone, (real + settings.extraSeconds + END_SAFETY_S) * 1000);
        break;
      }
      case 'ad-end':
        if (!state.muted) break;
        clearTimeout(timer);
        if (morePending()) adTimerDone(); // wait briefly for the next announced ad
        else endAd('site reported ad end');
        break;
      case 'skip':
        track({ e: 'ignored', reason: d.reason || '' });
        log('Ignored:', d.reason, d.name || '');
        break;
      case 'debug':
        log(d.label, d.data);
        break;
    }
  });

  window.addEventListener('pagehide', () => endAd('page closed'));

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.type === 'status') {
      reply({
        ...state,
        enabled: settings.enabled,
        site: { id: SITE.id, name: SITE.name, player: SITE.player, contentNoun: nounOf(content()), canSpeedThrough: !!SITE.canSpeedThrough },
        content: content(),
        speed: state.muted ? Speed.rate() : 1,
        playerMuted: playerMuted(),
      });
    }
    if (msg.type === 'unmute-now') { endAd('unmuted from popup'); reply({ ok: true }); }
  });
})();
