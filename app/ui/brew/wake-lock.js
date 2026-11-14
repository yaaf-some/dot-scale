// Screen Wake Lock while brewing. Not in every WebKit; when missing or refused it degrades silently (the screen may dim).
// The browser drops the lock when the page is hidden, so it is requested again when the page comes back.
export function createWakeLock() {
  let lock = null;
  let wanted = false;

  async function acquire() {
    if (!wanted || lock || !navigator.wakeLock?.request || document.visibilityState !== 'visible') return;
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
      if (!wanted) release();
    } catch { lock = null; } // refused (battery saver, permissions): fine
  }
  function release() {
    const l = lock; lock = null;
    try { l?.release(); } catch { /* ignore */ }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') acquire(); };

  return {
    start() { if (wanted) return; wanted = true; document.addEventListener('visibilitychange', onVisible); acquire(); },
    stop() { wanted = false; document.removeEventListener('visibilitychange', onVisible); release(); },
    get active() { return !!lock; },
  };
}
