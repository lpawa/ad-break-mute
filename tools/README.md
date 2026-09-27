# Tools

| File | What it's for |
|---|---|
| `generic-ad-probe.js` | Investigating any streaming site. Paste into the site's DevTools Console, mark 3–5 ad breaks, then run `__adProbe.report()` to see which signals line up with the ads. |
| `hotstar-ad-probe.js` | The probe used to build the JioHotstar module. |
| `prime-video-ad-probe.js` | The probe used to build the Prime Video module. |
| `analytics-apps-script.gs` | The Google Apps Script that receives opt-in anonymous stats. See [docs/ANALYTICS.md](../docs/ANALYTICS.md). |

## Using the generic probe

1. Start playing something with ads on the site, and open DevTools (**View → Developer → JavaScript Console**).
2. Paste the whole of `generic-ad-probe.js` and press Return. Chrome may ask you to type `allow pasting` first.
3. For each ad break, mark when the ad appears and when the show returns:
   - click the video, then press **Option+A** (ad on screen) and **Option+M** (show back), or
   - run `__adProbe.mark('ad on screen')` and `__adProbe.mark('show back')` in the Console.
4. After 3–5 breaks, run `__adProbe.report()`. Signals near every mark, with a small offset and few total events,
   are the ones to build a site module on.
5. Run `__adProbe.download()` to save everything as JSON for later.

If a tracker floods the log, hide it with `__adProbe.ignore(/tracker-name/)`.
