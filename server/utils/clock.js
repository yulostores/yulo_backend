// The one clock for time-based features (starting with live customer activity). Feature code
// calls `now()` instead of `new Date()` / `Date.now()`, so tests can move time
// deterministically with `__setClockForTests`.

let override = null;

/** The current time as a Date. */
export const now = () => (override ? new Date(override()) : new Date());

/** Tests only: `fn` returns a Date or a millisecond timestamp; `null` restores the real clock. */
export const __setClockForTests = (fn) => {
  override = typeof fn === 'function' ? fn : null;
};
