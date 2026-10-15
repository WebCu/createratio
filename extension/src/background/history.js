(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ActivityHistory = api;
})(globalThis, function () {
  'use strict';
  const DAYS = 30, MAX_BYTES = 4 * 1024 * 1024, PREFIX = '_websiteTime:';
  const dateForKey = key => /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : key.startsWith(PREFIX) && /^\d{4}-\d{2}-\d{2}$/.test(key.slice(PREFIX.length)) ? key.slice(PREFIX.length) : null;
  const bytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
  const isCollection = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const collection = value => isCollection(value) ? value : {};
  const nonnegative = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const websiteDay = value => Object.fromEntries(Object.entries(collection(value)).map(([domain, sec]) => [domain, nonnegative(sec)]));
  function create(storage, core, maxBytes = MAX_BYTES) {
    const receiptLimit = core.DELIVERY_LIMITS.receiptLimit;
    let preparedDate = null, sizes = new Map();
    function dates(count = DAYS) { return core.recentDates(count, new Date()); }
    function retained(date) { return core.validLocalDate(date) && date >= dates()[0]; }
    function eligible(date) { return dates().includes(date); }
    function creationDay(value) {
      return Object.fromEntries(Object.entries(collection(value)).map(([site, stats]) => {
        if (!isCollection(stats)) return [site, {}];
        const normalized = core.statsSnapshot(stats);
        return [site, Object.fromEntries(Object.entries(stats).map(([key, value]) => [key, Object.hasOwn(normalized, key) ? normalized[key] : value]))];
      }));
    }
    async function remove(keys) {
      if (!keys.length) return;
      await storage.remove(keys);
      for (const key of keys) sizes.delete(key);
    }
    async function save(values) {
      const changes = Object.fromEntries(Object.entries(values).filter(([key]) => !dateForKey(key) || retained(dateForKey(key))));
      const projected = new Map(sizes);
      for (const [key, value] of Object.entries(changes)) if (dateForKey(key)) projected.set(key, bytes(key, value));
      let total = [...projected.values()].reduce((sum, size) => sum + size, 0);
      const oldest = [...new Set([...projected.keys()].map(dateForKey))].filter(date => date !== core.localDate(new Date())).sort();
      const evicted = [];
      function evict() {
        const date = oldest.shift();
        if (!date) throw new Error('History storage is full. Export and clear history in Settings to continue.');
        for (const key of [...projected.keys()]) if (dateForKey(key) === date) {
          total -= projected.get(key); projected.delete(key); delete changes[key]; evicted.push(key);
        }
      }
      while (total > maxBytes) evict();
      await remove(evicted);
      while (Object.keys(changes).length) {
        try { await storage.set(changes); break; }
        catch (error) {
          if (!/quota/i.test(error.message)) throw error;
          const start = evicted.length; evict(); await remove(evicted.slice(start));
        }
      }
      sizes = projected;
    }
    async function prepare() {
      const today = core.localDate(new Date());
      if (preparedDate === today) return;
      const stored = await storage.get(null), expired = [];
      sizes = new Map();
      for (const [key, value] of Object.entries(stored)) {
        const date = dateForKey(key);
        if (!date) continue;
        if (!retained(date)) expired.push(key); else sizes.set(key, bytes(key, value));
      }
      await remove(expired);
      const migrated = {};
      const receipts = stored._receipts;
      const malformedReceipts = receipts != null && (!Array.isArray(receipts) || receipts.length > receiptLimit || ![...receipts].every(id => typeof id === 'string' && id.length <= core.DELIVERY_LIMITS.maxIdLength) || new Set(receipts).size !== receipts.length);
      const generation = stored._historyGeneration;
      const malformedGeneration = generation != null && (typeof generation !== 'string' || !generation.length);
      if (malformedReceipts || malformedGeneration || generation == null && Array.isArray(receipts) && receipts.length >= receiptLimit) {
        migrated._receipts = [];
        migrated._historyGeneration = crypto.randomUUID();
      }
      for (const [date, value] of Object.entries(collection(stored._websiteTime))) {
        const key = PREFIX + date;
        if (!retained(date)) continue;
        if (!Object.hasOwn(stored, key)) migrated[key] = value;
        else if (isCollection(value)) {
          const day = collection(stored[key]);
          if (!isCollection(stored[key]) || Object.keys(value).some(domain => !Object.hasOwn(day, domain))) migrated[key] = { ...value, ...day };
        }
      }
      await save(Object.hasOwn(stored, '_websiteTime') ? { _websiteTime: {}, ...migrated } : migrated);
      if (Object.hasOwn(stored, '_websiteTime')) await storage.remove('_websiteTime');
      preparedDate = today;
    }
    async function read(kind, range = 'month') {
      await prepare();
      const selected = dates(range === 'today' ? 1 : range === 'week' ? 7 : DAYS);
      const prefix = kind === 'websites' ? PREFIX : '';
      const stored = await storage.get(selected.map(date => prefix + date));
      return Object.fromEntries(selected.filter(date => Object.hasOwn(stored, prefix + date)).map(date => [date, kind === 'websites' ? websiteDay(stored[prefix + date]) : creationDay(stored[prefix + date])]));
    }
    async function clear(generation) {
      const stored = await storage.get(null);
      const keys = Object.keys(stored).filter(key => dateForKey(key) || key === '_websiteTime');
      if (generation !== undefined) {
        const reset = { _historyGeneration: generation };
        try { await storage.set(reset); }
        catch (error) {
          if (error.name !== 'QuotaExceededError' && error.message !== 'Resource::kQuotaBytes quota exceeded' && !/\bQUOTA_BYTES(?:_PER_ITEM)?(?: quota)? exceeded\b/i.test(error.message)) throw error;
          await storage.set({ ...Object.fromEntries(keys.map(key => [key, {}])), ...reset });
          for (const key of keys) if (dateForKey(key)) sizes.set(key, bytes(key, {}));
        }
      }
      await remove(keys);
      sizes = new Map(); preparedDate = core.localDate(new Date());
    }
    async function recordCreation(packet) {
      const selected = [...new Set([...packet.segments, ...packet.actions].map(item => item.date))].filter(eligible);
      const stored = await storage.get([...selected, '_receipts']);
      const receipts = stored._receipts || [];
      if (receipts.includes(packet.id)) return;
      const changes = {};
      for (const date of selected) {
        const day = collection(stored[date]), stats = collection(day[packet.site]);
        day[packet.site] = { ...stats, ...core.statsSnapshot(stats) };
        changes[date] = day;
      }
      for (const segment of packet.segments) {
        if (changes[segment.date]) changes[segment.date][packet.site][segment.mode + 'Sec'] += segment.sec;
      }
      for (const item of packet.actions) {
        if (!changes[item.date]) continue;
        changes[item.date][packet.site][item.action] += 1;
        if (item.action === 'quotes') changes[item.date][packet.site].posts += 1;
      }
      if (receipts.length >= receiptLimit) {
        changes._historyGeneration = crypto.randomUUID();
        changes._receipts = [packet.id];
      } else {
        changes._receipts = [...receipts, packet.id];
      }
      await save(changes);
    }
    async function recordWebsiteTime(domain, segments) {
      await prepare();
      const selected = segments.filter(segment => eligible(segment.date));
      const stored = await storage.get(selected.map(segment => PREFIX + segment.date));
      const changes = {};
      for (const { date, sec } of selected) {
        const key = PREFIX + date;
        const day = changes[key] || collection(stored[key]);
        const total = Object.hasOwn(day, domain) ? nonnegative(day[domain]) : 0;
        changes[key] = { ...day, [domain]: total + sec };
      }
      await save(changes);
    }
    return { prepare, save, read, clear, retained, creationDay, recordCreation, recordWebsiteTime };
  }
  return { DAYS, MAX_BYTES, PREFIX, create };
});
