// Poll only while the page can receive updates. Resume events bypass the poll delay.
export function createChatSync({
  refresh, onState, onUnauthorized,
  isVisible = () => !document.hidden,
  isOnline = () => navigator.onLine !== false,
  setTimer = setTimeout, clearTimer = clearTimeout,
  now = Date.now, random = Math.random, baseDelay = 30000
}) {
  let active = false, timer = null, cycle = null;
  let delay = baseDelay, lastSyncedAt = null, failed = false;
  const available = () => isVisible() && isOnline();
  function snapshot() {
    return {
      status: !active ? 'idle' : !isOnline() ? 'offline' : !isVisible() ? 'paused'
        : cycle ? 'syncing' : failed ? 'retrying' : 'synced',
      lastSyncedAt
    };
  }
  const publish = () => onState(snapshot());
  function cancelTimer() { clearTimer(timer); timer = null; }
  function schedule() {
    cancelTimer();
    if (active && available()) {
      timer = setTimer(() => { void requestRefresh().catch(() => {}); }, delay + random() * 5000);
    }
  }
  function stop() {
    active = false; cycle = null; cancelTimer();
    lastSyncedAt = null; failed = false; delay = baseDelay;
    publish();
  }
  function requestRefresh() {
    cancelTimer();
    if (!active || !available()) { publish(); return Promise.resolve(); }
    if (cycle) {
      // A mutation or resume during a request needs a fresh snapshot after it finishes.
      cycle.again = true;
      return cycle.promise;
    }
    const current = { again: false, promise: null };
    const isCurrent = () => active && cycle === current;
    cycle = current;
    current.promise = Promise.resolve().then(async () => {
      try {
        do {
          if (!isCurrent()) return;
          current.again = false;
          await refresh(isCurrent);
          if (!isCurrent()) return;
          lastSyncedAt = now(); failed = false; delay = baseDelay;
        } while (current.again && available());
      } catch (error) {
        if (!isCurrent()) return;
        if (error.status === 401) { stop(); onUnauthorized(); }
        else { failed = true; delay = Math.min(delay * 2, 300000); }
        throw error;
      } finally {
        if (isCurrent()) { cycle = null; publish(); schedule(); }
      }
    });
    publish();
    return current.promise;
  }
  function availabilityChanged() {
    cancelTimer();
    if (active && available()) {
      delay = baseDelay;
      void requestRefresh().catch(() => {});
    } else publish();
  }
  return {
    start() { stop(); active = true; return requestRefresh(); },
    stop, refresh: requestRefresh, availabilityChanged, snapshot
  };
}
