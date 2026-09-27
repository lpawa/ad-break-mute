// Prime Video detection. Prime's player shows an ad countdown for the whole break
// ("Ad 0:42", aria-label "Ad playing. Content resumes in 0 minutes and 42 seconds.")
// and removes it when the show resumes. The countdown follows playback, so it also
// stops while you pause. This runs in the extension's isolated world: it only reads the DOM.
//   countdown appears   -> ad-start (seconds = time left in the break)
//   countdown ticks     -> ad-progress
//   countdown gone      -> ad-end
(() => {
  if (globalThis.__adBreakMutePrime) return;
  globalThis.__adBreakMutePrime = true;

  const emit = detail => document.dispatchEvent(new CustomEvent('ad-break-mute', { detail: JSON.stringify(detail) }));

  // Stable class first; the aria-label is a fallback, since it's translated with the UI language.
  const TIMER_SELECTORS = ['.atvwebplayersdk-ad-timer-remaining-time', '[aria-label^="Ad playing"]'];
  const END_CONFIRM_MS = 250; // the countdown must stay gone this long before we call the break over

  const visible = el => el.isConnected &&
    (el.checkVisibility ? el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) : el.getClientRects().length > 0);

  const findTimer = () => {
    for (const sel of TIMER_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) if (visible(el)) return el;
    }
    return null;
  };

  // "0:42" in the timer or its parent ("Ad 0:42"); otherwise the numbers in the aria-label
  const remainingOf = el => {
    for (let n = el, i = 0; n && i < 2; n = n.parentElement, i++) {
      const m = (n.textContent || '').match(/(\d+):(\d{2})/);
      if (m) return +m[1] * 60 + +m[2];
    }
    const labelled = el.closest('[aria-label]');
    const nums = ((labelled && labelled.getAttribute('aria-label')) || '').match(/\d+/g)?.map(Number) || [];
    if (nums.length >= 2) return nums[nums.length - 2] * 60 + nums[nums.length - 1];
    if (nums.length === 1) return nums[0];
    return null;
  };

  let inAd = false, missingSince = 0;
  const tick = () => {
    const el = findTimer();
    if (el) {
      missingSince = 0;
      const remaining = remainingOf(el);
      if (remaining == null) return;
      if (!inAd) {
        inAd = true;
        emit({ kind: 'ad-start', name: '', seconds: remaining, via: 'ad countdown' });
      } else {
        emit({ kind: 'ad-progress', remaining });
      }
    } else if (inAd) {
      const now = performance.now();
      if (!missingSince) {
        missingSince = now;
        setTimeout(tick, END_CONFIRM_MS); // confirm shortly, rather than waiting for the next poll
      } else if (now - missingSince >= END_CONFIRM_MS) {
        inAd = false;
        missingSince = 0;
        emit({ kind: 'ad-end' });
      }
    }
  };

  setInterval(tick, 400);
  // React straight away when the countdown appears or disappears, without waiting for the next poll
  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tick(); });
  }).observe(document.documentElement, { subtree: true, childList: true });
})();
