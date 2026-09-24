/**
 * Client-side E2E helpers — key derived from Room ID + password.
 * Server only ever sees ciphertext.
 */
const CryptoClient = (() => {
  const te = new TextEncoder();
  const td = new TextDecoder();

  function b64encode(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = "";
    bytes.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }

  function b64decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function deriveKey(roomId, password) {
    const material = await crypto.subtle.importKey(
      "raw",
      te.encode(`${roomId}:${password}`),
      "PBKDF2",
      false,
      ["deriveKey"]
    );
    const salt = te.encode(`ipsita-sathi-v1:${roomId}`);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 210000, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  }

  async function encryptText(key, plaintext) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      te.encode(plaintext)
    );
    return `v1.${b64encode(iv)}.${b64encode(ct)}`;
  }

  async function decryptText(key, payload) {
    try {
      const parts = payload.split(".");
      if (parts.length !== 3 || parts[0] !== "v1") return null;
      const iv = b64decode(parts[1]);
      const ct = b64decode(parts[2]);
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
      return td.decode(pt);
    } catch {
      return null;
    }
  }

  async function encryptBlob(key, arrayBuffer) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      arrayBuffer
    );
    const out = new Uint8Array(iv.length + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), iv.length);
    return out;
  }

  async function decryptBlob(key, encryptedBytes) {
    const iv = encryptedBytes.slice(0, 12);
    const ct = encryptedBytes.slice(12);
    return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  }

  return { deriveKey, encryptText, decryptText, encryptBlob, decryptBlob, b64encode };
})();
