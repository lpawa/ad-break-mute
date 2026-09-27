// Where anonymous usage stats are sent (a Google Apps Script web app URL; see docs/ANALYTICS.md).
// Leave empty to build without analytics: the setting disappears and nothing is ever sent.
const ANALYTICS_URL = '';

// Whether stats are shared for testers who haven't chosen yet. On during the beta; the popup tells them and offers
// "Turn off". Set to false before any public release, so sharing becomes opt-in.
const ANALYTICS_DEFAULT_ON = true;
