# Developing Ad Break Mute

Load `extension/` with **Load unpacked** in `chrome://extensions` (Developer mode on). After changing a file, click the
reload icon on the extension's card and refresh the streaming tab.

Anonymous usage stats are set up separately; see [ANALYTICS.md](ANALYTICS.md).

## Layout

All paths are inside `extension/`.

```
core/content.js        Site-agnostic engine: mute timing, overlay, stats, alerts (isolated world)
sites/<id>/page.js     Detection for one site; runs in the page's own context (world: MAIN)
sites/<id>/site.js     Describes the site to the core: names, wording, content id, ad labels
background.js          Mutes/unmutes tabs, shows notifications, batches opt-in stats
config.js              ANALYTICS_URL (always empty in git; release builds fill it from .analytics-url)
popup.html / popup.js  Status, stats, settings
```

## Adding a site

1. **Find the signals.** Paste `tools/generic-ad-probe.js` into the site's DevTools Console while something with ads
   is playing. During 3–5 ad breaks, mark each ad's start with Option+A (or `__adProbe.mark('ad on screen')`) and
   the moment the show returns with Option+M (or `__adProbe.mark('show back')`). Then run `__adProbe.report()`:
   it ranks every signal by how many of your marks it appeared near, and how far before or after them. The best
   candidates show up near every mark with few total events. `tools/` also has the probes used for JioHotstar and
   Prime Video, which are useful references. Signals to look for:
   - ad-decision requests (VAST/VMAP) with each ad's duration, and impression beacons,
   - on-screen ad UI: an "Ad" badge or countdown, or a class like YouTube's `ad-showing` on the player,
   - Google IMA SDK events (`start`, `complete`, `allAdsCompleted`), which many sites use,
   - markers in the stream manifest (SCTE-35, CUE-OUT/CUE-IN).
2. **Write `sites/<id>/page.js`.** Emit the core's events with
   `document.dispatchEvent(new CustomEvent('ad-break-mute', { detail: JSON.stringify(event) }))`:
   - `{ kind: 'break', ads: [{ name, seconds }] }` when upcoming ads are announced (optional)
   - `{ kind: 'ad-start', name, seconds?, via? }` when an ad starts. If `seconds` is missing, the core uses
     the announced duration, or the 30s fallback.
   - `{ kind: 'ad-end' }` when an ad ends, if the site signals it. Set `hasEndSignal: true` in `site.js`,
     and the timer becomes a safety net.
   - `{ kind: 'skip', name, reason }` and `{ kind: 'debug', label, data }` for console logging.
3. **Write `sites/<id>/site.js`,** setting `globalThis.AdBreakSite` to
   `{ id, name, player, contentNoun, backLabel, backTitle, hasEndSignal, content(), adLabel(name) }`.
   Copy `sites/hotstar/site.js` as a starting point.
4. **Register it** in `manifest.json` (two `content_scripts` entries, as for Hotstar, plus `host_permissions`),
   and add its display name to `SITE_NAMES` in `popup.js`.

## Debugging

Every decision is logged to the site tab's DevTools Console with an `[Ad Break Mute · <site>]` prefix.

## Speeding through ads (Prime Video)

"Speed through ads on Prime Video" plays each ad break at 2–16× (default 8×) while it's muted and covered, then
restores the speed you were watching at. It's on by default and can be turned off in the popup. Clicking the countdown
to watch an ad also returns that ad to normal speed. It only runs on sites whose `site.js` sets `canSpeedThrough: true`.
Set that to `false` in any build you publish or share, since skipping ads is against Prime Video's terms.
