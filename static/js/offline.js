/**
 * Offline cache + outbox sync for Ipsita-Sathi.
 */
const OfflineStore = (() => {
  const KEY = "ipsita_sathi_cache_v1";

  function load() {
    try {
      return JSON.parse(localStorage.getItem(KEY) || "{}");
    } catch {
      return {};
    }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function setSession(session) {
    const d = load();
    d.session = session;
    save(d);
  }

  function getSession() {
    return load().session || null;
  }

  function clearSession() {
    const d = load();
    delete d.session;
    save(d);
  }

  function cacheMessages(roomId, messages) {
    const d = load();
    d.messages = d.messages || {};
    d.messages[roomId] = messages.slice(-200);
    save(d);
  }

  function getCachedMessages(roomId) {
    return (load().messages || {})[roomId] || [];
  }

  function enqueueOutbox(item) {
    const d = load();
    d.outbox = d.outbox || [];
    d.outbox.push({ ...item, queuedAt: Date.now() });
    save(d);
  }

  function getOutbox() {
    return load().outbox || [];
  }

  function setOutbox(items) {
    const d = load();
    d.outbox = items;
    save(d);
  }

  return {
    setSession,
    getSession,
    clearSession,
    cacheMessages,
    getCachedMessages,
    enqueueOutbox,
    getOutbox,
    setOutbox,
  };
})();
