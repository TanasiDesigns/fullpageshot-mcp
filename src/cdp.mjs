// Minimal Chrome DevTools Protocol client over WebSocket.
// Zero dependencies: uses Node's global `WebSocket` (Node >= 22) and `fetch`.
//
// A single (flattened) connection to the browser is enough: page commands are
// addressed with a `sessionId` obtained from Target.attachToTarget.

export class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map(); // id -> { resolve, reject }
  #listeners = new Map(); // method -> Set<fn>

  constructor(ws) {
    this.#ws = ws;
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data));
    ws.addEventListener('close', () => {
      for (const { reject } of this.#pending.values()) reject(new Error('CDP connection closed'));
      this.#pending.clear();
    });
  }

  /** Connect to a `ws://…/devtools/browser/…` endpoint. */
  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`WebSocket connect timed out: ${url}`)), timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket connection failed: ${url}`)); }, { once: true });
    });
    return new CdpClient(ws);
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : String(raw)); } catch { return; }

    if (msg.id != null) {
      const pending = this.#pending.get(msg.id);
      if (!pending) return;
      this.#pending.delete(msg.id);
      if (msg.error) {
        const err = new Error(msg.error.message + (msg.error.data ? `: ${msg.error.data}` : ''));
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (msg.method) {
      const set = this.#listeners.get(msg.method);
      if (set) for (const fn of [...set]) fn(msg.params, msg.sessionId);
      const all = this.#listeners.get('*');
      if (all) for (const fn of [...all]) fn(msg);
    }
  }

  /** Send a command, optionally scoped to a page session. */
  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#ws.send(JSON.stringify(payload));
      } catch (e) {
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  on(method, fn) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(fn);
    return () => this.#listeners.get(method)?.delete(fn);
  }

  once(method, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, sessionId) => {
        off();
        if (timer) clearTimeout(timer);
        resolve({ params, sessionId });
      });
      const timer = timeoutMs ? setTimeout(() => { off(); reject(new Error(`Timed out waiting for ${method}`)); }, timeoutMs) : null;
    });
  }

  close() {
    try { this.#ws.close(); } catch { /* already closed */ }
  }
}