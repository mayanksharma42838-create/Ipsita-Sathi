/**
 * Offline cache + outbox sync for Ipsita-Sathi.
 */
const OfflineStore = (() => {
  const KEY = "ipsita_sathi_cache_v1";
  const KEY_DB = "sathi_room_keys_v1";

  function openKeyDb() {
    if (!window.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(KEY_DB, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("roomKeys");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function setRoomKey(roomId, key) {
    const database = await openKeyDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("roomKeys", "readwrite");
      transaction.objectStore("roomKeys").put(key, roomId);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
      transaction.onabort = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }

  async function getRoomKey(roomId) {
    const database = await openKeyDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("roomKeys", "readonly");
      const request = transaction.objectStore("roomKeys").get(roomId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => database.close();
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }

  async function clearRoomKey(roomId) {
    const database = await openKeyDb();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction("roomKeys", "readwrite");
      transaction.objectStore("roomKeys").delete(roomId);
      transaction.oncomplete = () => {
        database.close();
        resolve();
      };
      transaction.onerror = () => {
        database.close();
        reject(transaction.error);
      };
    });
  }

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

  function clearRoomData(roomId) {
    const d = load();
    if (d.messages) delete d.messages[roomId];
    d.outbox = [];
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
    setRoomKey,
    getRoomKey,
    clearRoomKey,
    clearRoomData,
    cacheMessages,
    getCachedMessages,
    enqueueOutbox,
    getOutbox,
    setOutbox,
  };
})();
