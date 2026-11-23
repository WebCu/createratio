(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../../core/core.js') : root.Core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SiteAccessModel = api;
})(globalThis, function (Core) {
  'use strict';
  /** @typedef {{ phase: 'request', readyAt: number, waitMs: Milliseconds | null }} AccessRequest */
  /** @typedef {{ phase: 'session', remainingMs: Milliseconds | null, expiresAt: number | null, refilledAt: number | null, date: LocalDate | null, goalActive: boolean }} AccessSession */
  /** @typedef {AccessRequest | AccessSession | null} SiteAccessState */
  const MAXIMUM_BUDGET = Core.millisecondsFromMinutes(Core.ACCESS_LIMITS.maxMinutes);
  const SESSION_FIELDS = ['remainingMs', 'expiresAt', 'refilledAt'];
  /**
   * @param {unknown} value
   * @returns {value is Record<string, any>}
   */
  function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }
  function validSession(raw, now) {
    return (
      (!Object.hasOwn(raw, 'date') || Core.validLocalDate(raw.date)) &&
      SESSION_FIELDS.every(field => !Object.hasOwn(raw, field) || (Number.isFinite(raw[field]) && raw[field] >= 0)) &&
      (!Object.hasOwn(raw, 'remainingMs') || raw.remainingMs <= MAXIMUM_BUDGET) &&
      (Object.hasOwn(raw, 'remainingMs') || !Object.hasOwn(raw, 'expiresAt') || raw.expiresAt - now <= MAXIMUM_BUDGET)
    );
  }
  function validWaitDuration(value) {
    return Number.isFinite(value) && Core.validAccessMinutes(Core.minutesFromMilliseconds(value));
  }
  function waitDurationFromStored(value) {
    const wait = Core.asMilliseconds(value);
    return validWaitDuration(wait) ? wait : Core.millisecondsFromMinutes(Core.ACCESS_LIMITS.minMinutes);
  }
  function validWait(raw, now) {
    return Number.isFinite(raw.readyAt) && raw.readyAt > 0 && raw.readyAt <= now + waitDurationFromStored(raw.waitMs);
  }
  function numberOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }
  /**
   * @param {unknown} raw
   * @param {number} now
   * @returns {SiteAccessState}
   */
  function siteAccessFromStored(raw, now) {
    if (!record(raw) || !validSession(raw, now)) return null;
    const hasDate = Object.hasOwn(raw, 'date');
    if (Number.isFinite(raw.remainingMs) || Number.isFinite(raw.expiresAt) || raw.refilledAt > 0 || hasDate) {
      const remaining = Number.isFinite(raw.remainingMs)
        ? raw.remainingMs
        : Number.isFinite(raw.expiresAt)
          ? Math.max(0, raw.expiresAt - now)
          : null;
      return {
        phase: 'session',
        remainingMs: remaining === null ? null : Core.asMilliseconds(remaining),
        expiresAt: numberOrNull(raw.expiresAt),
        refilledAt: numberOrNull(raw.refilledAt),
        date: hasDate ? raw.date : null,
        goalActive: raw.goalActive === true
      };
    }
    if (!validWait(raw, now)) return null;
    return {
      phase: 'request',
      readyAt: raw.readyAt,
      waitMs: validWaitDuration(raw.waitMs) ? Core.asMilliseconds(raw.waitMs) : null
    };
  }
  /**
   * @param {SiteAccessState} state
   * @returns {Record<string, unknown> | undefined}
   */
  function storedFromSiteAccess(state) {
    if (state === null) return undefined;
    const fields =
      state.phase === 'request'
        ? { readyAt: state.readyAt, waitMs: state.waitMs }
        : {
            remainingMs: state.remainingMs,
            expiresAt: state.expiresAt,
            refilledAt: state.refilledAt,
            date: state.date,
            goalActive: state.goalActive || null
          };
    return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  }
  /** @param {AccessRequest} request */
  function waitDuration(request) {
    return waitDurationFromStored(request.waitMs);
  }
  /**
   * @param {unknown} a
   * @param {unknown} b
   */
  function sameStoredEntry(a, b) {
    if (!record(a) || !record(b)) return a === b;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && Object.is(a[key], b[key]))
    );
  }
  return { siteAccessFromStored, storedFromSiteAccess, waitDuration, sameStoredEntry };
});
