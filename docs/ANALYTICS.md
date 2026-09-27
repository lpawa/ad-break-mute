# Anonymous usage stats

The extension batches anonymous events and sends them to a Google Sheet through a small Apps Script, so there's no
server to run. Nothing is sent unless the build has an `ANALYTICS_URL`.

**Default:** `ANALYTICS_DEFAULT_ON` in `extension/config.js` decides what happens for testers who haven't chosen.
During the beta it's `true`: stats are shared from install, and the popup shows a one-time notice with **OK** and
**Turn off**. Set it to `false` before any public release. Sharing then becomes opt-in, and the notice becomes a
**Share stats / No thanks** question. Whatever a tester chooses always wins over the default.

## What's sent

Every batch carries a random install id (created when someone opts in, deleted when they opt out), the extension
version, and events like these, each stamped with the day only:

| Event | Fields | Tells you |
|---|---|---|
| `ad` | site, ad length in seconds, whether the length was known, how the ad was spotted, speed, brand (JioHotstar only) | How many ads, how long, whether detection is working |
| `end` | site, why muting ended (`ad finished`, `ad break over`, `site reported ad end`, `unmuted from popup`, ...) | Whether breaks end cleanly; frequent `unmuted from popup` suggests mistakes |
| `ignored` | site, reason | Ad-like signals the extension skipped |
| `speed-reset` | site | The player fought speed-through |
| `daily` | settings (on/off, countdown, speed, wait, alerts) | Which settings people actually use |

Never sent: what anyone watches (titles, URLs, match or show ids), the time of day, IP-derived location beyond what
Google itself sees, or anything identifying. With a small group of friends, the install ids are anonymous in name
only, since you'll know who's testing, so say so when you invite them.

## Setting it up

1. Create a new Google Sheet, for example "Ad Break Mute stats".
2. Open **Extensions → Apps Script**, delete the sample code, and paste in `tools/analytics-apps-script.gs`.
3. In the editor, choose `setup` in the function menu and click **Run**. Approve the permissions it asks for
   (it only needs this spreadsheet). This creates the `events` and `summary` sheets.
4. Click **Deploy → New deployment**, pick **Web app**, set **Execute as: Me** and
   **Who has access: Anyone**, then **Deploy** and copy the web app URL (it ends in `/exec`).
5. Save the URL in a file named `.analytics-url` at the root of the repo, on its own line. The file is gitignored,
   so it never gets committed.
6. Run `./scripts/package.sh`. It writes the URL into the zip's copy of `config.js` and prints
   `analytics: on`. The `extension/config.js` in git stays empty.

To try stats in your own unpacked copy before releasing, paste the URL into `extension/config.js` temporarily,
and put it back to `''` before committing.

The `summary` sheet updates by itself: testers, ads per site, ads with unknown lengths, how ads were spotted, how
breaks ended, top brands, problems, and versions in use.

## Checking it works

Opt in from the popup, then in `chrome://extensions` click **service worker** on the extension's card to open its
console, and run:

```js
Analytics.track({ e: 'test', site: 'manual' }); Analytics.flush();
```

A row with event `test` should appear in the `events` sheet within a few seconds. Events are otherwise sent in
batches of 20, or every 30 minutes.

## Keeping the URL private

The URL can't be completely hidden: it has to be inside the extension so the extension can send to it, and anyone
with the extension can read its files. What matters is what the URL does and doesn't allow:

- **It can't be used to read your data.** It only accepts new rows. The Sheet stays private to your Google account,
  and the script has no `doGet`, so opening the URL in a browser shows an error, never data. Don't share the Sheet
  or the Apps Script project with anyone.
- **It isn't in the repo.** It lives in the gitignored `.analytics-url` file and is added only to release zips, so
  it stays out of git history even if the repo is made public later. Before that, check with
  `git log -p -S script.google.com`. If it was ever committed, rotate it (below).
- **Junk is rejected, and flooding is capped.** The script only accepts batches with a random-looking install id, a
  version like `0.7.1`, and the extension's own event types, and trims every field. Each install can post at most
  20 batches an hour (real testers send at most 2), and everyone together at most 5,000 events an hour.

**Rotating the URL**, if it leaks somewhere public or junk starts arriving:

1. In the Apps Script editor, **Deploy → New deployment** (Web app, same settings) and copy the new URL into
   `.analytics-url`.
2. **Deploy → Manage deployments**, select the old deployment and **Archive** it. The old URL stops working
   immediately.
3. Bump the version, run `./scripts/package.sh`, and publish the release. Testers on older versions stop sending
   until they update.

To clear out junk rows, filter the `events` sheet by `install` or `received` time and delete them.

## Notes

- After changing the script, publish it with **Deploy → Manage deployments → Edit (pencil) → Version: New version →
  Deploy**. That keeps the same URL; **New deployment** creates a new one, which then needs to go in `.analytics-url`.
- Builds made without a `.analytics-url` file never send anything.
