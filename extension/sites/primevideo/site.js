// Prime Video description for the core. Prime shows one countdown for the whole
// ad break and no ad names, so stats count ad breaks rather than brands.
globalThis.AdBreakSite = {
  id: 'primevideo',
  name: 'Prime Video',
  player: "Prime Video's player",
  contentNoun: 'show',             // fallback; content() says "episode" or "movie" once the player is open
  adNoun: 'ad break',
  backLabel: 'Back in',            // notification title comes from the noun: "Your episode is back"

  hasEndSignal: true,              // the on-screen ad countdown disappears when the break ends
  // Allows the "speed through ads" setting on this site. Set to false before publishing
  // to the Chrome Web Store: skipping ads is against Prime Video's terms.
  canSpeedThrough: true,

  content() {
    const asin = (location.pathname.match(/\/(?:detail|dp)\/([A-Z0-9]{8,})/i) || location.search.match(/[?&]gti=([^&]+)/) || [])[1];
    const title = (document.querySelector('.atvwebplayersdk-title-text')?.textContent || document.title)
      .replace(/^(Prime Video|Amazon\.[a-z.]+)\s*:\s*/i, '')
      .replace(/\s*[-|]\s*(Prime Video|Amazon).*$/i, '')
      .trim() || 'This show';
    const playerTitle = document.querySelector('.atvwebplayersdk-title-text');
    const episode = document.querySelector('.atvwebplayersdk-subtitle-text')?.textContent.trim() || '';
    // Series show a subtitle like "Season 1, Ep. 3" under the title; movies don't
    const noun = episode ? 'episode' : playerTitle ? 'movie' : 'show';
    return {
      id: (asin || location.pathname) + (episode ? ':' + episode : ''),
      title: episode ? `${title}, ${episode}` : title,
      noun,
    };
  },

  adLabel: () => '', // no ad names on Prime
};
