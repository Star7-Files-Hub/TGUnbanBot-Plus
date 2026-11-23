// Account-wide D1 protection policy. Analytics are delayed snapshots, not a hard limit.
export const READ_LIMIT = 5_000_000;
export const WRITE_LIMIT = 100_000;
export const MAX_THRESHOLD = 0.8;
export const MAX_USAGE_AGE = 300_000;
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const nonNegative = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function usageRatio(account) {
  if (!nonNegative(account.rowsRead) || !nonNegative(account.rowsWritten)
      || !Number.isFinite(account.readLimit) || !Number.isFinite(account.writeLimit)
      || account.readLimit <= 0 || account.writeLimit <= 0
      || !nonNegative(account.localReads ?? 0) || !nonNegative(account.localWrites ?? 0)) return null;
  return Math.max((account.rowsRead + (account.localReads || 0)) / account.readLimit,
    (account.rowsWritten + (account.localWrites || 0)) / account.writeLimit);
}
export function availability(account, version, threshold = MAX_THRESHOLD, now = Date.now()) {
  if (!account.enabled) return 'disabled';
  if (account.day !== utcDay(now) || !Number.isFinite(account.observedAt)
      || now - account.observedAt < 0 || now - account.observedAt > MAX_USAGE_AGE) return 'usage_unknown';
  const ratio = usageRatio(account);
  if (ratio === null || account.error) return 'usage_unknown';
  const cutoff = Number.isFinite(threshold) && threshold >= 0.1 ? Math.min(MAX_THRESHOLD, threshold) : MAX_THRESHOLD;
  if (ratio >= cutoff) return 'at_threshold';
  if (account.cooldownUntil > now) return 'cooldown';
  if (!version || account.version !== version) return 'dictionary_unsynced';
  return null;
}
export function eligibleAccounts(accounts, version, config, now = Date.now()) {
  const eligible = accounts.filter(a => availability(a, version, config.threshold, now) === null);
  return config.mode === 'balanced' ? eligible.sort((a, b) => usageRatio(a) - usageRatio(b)
    || (a.lastDispatch || 0) - (b.lastDispatch || 0)) : eligible;
}
export function parseD1Usage(body) {
  if (!body || (Array.isArray(body.errors) ? body.errors.length > 0 : body.errors != null)) return null;
  const accounts = body.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) return null;
  const rows = accounts[0]?.d1AnalyticsAdaptiveGroups;
  if (!Array.isArray(rows) || rows.length > 1) return null;
  if (!rows.length) return { rowsRead: 0, rowsWritten: 0 };
  const sums = rows[0]?.sum;
  if (!nonNegative(sums?.rowsRead) || !nonNegative(sums?.rowsWritten)) return null;
  return { rowsRead: sums.rowsRead, rowsWritten: sums.rowsWritten };
}
export function mergeUsage(account, usage, now = Date.now()) {
  const sameDay = account.day === utcDay(now);
  const previous = sameDay ? account : {};
  // Keep a conservative local delta for the whole UTC day. Resetting it on every
  // delayed Analytics poll could dispatch work past a previously observed cutoff.
  return { ...account, day: utcDay(now), observedAt: now,
    rowsRead: Math.max(previous.rowsRead || 0, usage.rowsRead),
    rowsWritten: Math.max(previous.rowsWritten || 0, usage.rowsWritten),
    localReads: previous.localReads || 0, localWrites: previous.localWrites || 0, error: null };
}
