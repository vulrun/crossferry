// Fixed-window counter per origin host, matching cors-anywhere: the window resets every period,
// exempt hosts are never counted, and rejected requests do not advance the counter.
// State lives in this process only; on serverless platforms that means per instance.
export function createMemoryRateLimiter({ max, periodMs, exempt = [], now = Date.now }) {
  let windowStart = now();
  let counts = new Map();

  const unit = periodMs === 60_000 ? "minute" : `${periodMs / 60_000} minutes`;
  const message = `The number of requests is limited to ${max} per ${unit}. Please self-host this service if you need more quota.`;

  const isExempt = (host) => exempt.some((entry) => (entry instanceof RegExp ? entry.test(host) : entry === host));

  return {
    async check(originHost) {
      const host = String(originHost || "-").toLowerCase();
      if (isExempt(host)) return null;

      const time = now();
      if (time - windowStart >= periodMs) {
        windowStart = time;
        counts = new Map();
      }

      const used = counts.get(host) || 0;
      if (used >= max) return message;
      counts.set(host, used + 1);
      return null;
    },
  };
}
