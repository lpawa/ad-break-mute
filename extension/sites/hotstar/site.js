// JioHotstar description for the core: naming and wording only, no detection.
globalThis.AdBreakSite = {
  id: 'hotstar',
  name: 'JioHotstar',
  player: "Hotstar's player",
  contentNoun: 'match',               // "Ad 3 this match"
  backLabel: 'Match back in',         // countdown heading
  backTitle: 'The match is back',     // notification title
  hasEndSignal: false,                // ads end on a timer from the VAST duration

  // /in/sports/cricket/india-vs-west-indies-1st-odi/1540080152/video/live/watch
  content() {
    const parts = location.pathname.split('/').filter(Boolean);
    const i = parts.findIndex(p => /^\d{6,}$/.test(p));
    const id = i >= 0 ? parts[i] : location.pathname;
    const slug = i > 0 ? parts[i - 1] : '';
    const title = slug
      ? slug.split('-').map(w => /^(vs|v)$/i.test(w) ? 'vs' : /^(odi|t20i?|ipl|wpl)$/i.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)).join(' ')
      : (document.title || 'This match');
    return { id, title };
  },

  // Two ad title formats seen so far:
  //   "PR-26-056537_INDvsWI26_InstamartBT_IMRS50OFF..." -> "Instamart"
  //   "SSAI_VIMAL_KESARI_HOLI_OPT_1_HING_10"             -> "Vimal Kesari"
  adLabel(adName) {
    const titleCase = w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    const parts = (adName || '').split('_').filter(Boolean);
    if (parts[0]?.startsWith('PR-') && parts.length > 2) {
      const b = parts[2];
      if (/^[A-Z]{2,4}vs?[A-Z]{2,4}/.test(b)) return 'Hotstar promo'; // e.g. "INDvWIT2026"
      return b.replace(/(?<=[a-z])[A-Z0-9]{1,3}$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'Unnamed ad';
    }
    const words = parts.filter(w => !/^(SSAI|CSAI|AD|ADS)$/i.test(w));
    const name = [];
    for (const w of words) {
      if (!/^[A-Za-z]{2,}$/.test(w) || name.length === 2) break;
      name.push(titleCase(w));
    }
    return name.join(' ') || 'Unnamed ad';
  },
};
