// Browser lifecycle + page control built on the tiny CDP client.
// Zero dependencies. Launches an already-installed Chromium browser in the
// background (headless) or with a visible window.

import { spawn } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CdpClient } from './cdp.mjs';

const SPAWN_WAIT_MS = 20000;
const LOAD_TIMEOUT_MS = 30000;
const MAX_CAPTURE_PX = 16384; // Chrome's practical screenshot dimension ceiling

const CANDIDATE_BROWSERS = [
  process.env.FULLPAGESHOT_CHROME,
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/brave-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowserExecutable() {
  return CANDIDATE_BROWSERS.find((p) => p && existsSync(p)) || null;
}

async function waitForDevToolsPort(userDataDir, child, timeoutMs) {
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const started = Date.now();
  for (;;) {
    if (child.exitCode != null) throw new Error(`Browser exited early (code ${child.exitCode})`);
    try {
      const txt = await fs.readFile(portFile, 'utf8');
      const port = parseInt(txt.split('\n')[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch { /* not written yet */ }
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the browser to expose a DevTools port');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Launch a Chromium-based browser with an ephemeral debugging port.
 * @param {{headless?: boolean, width?: number, height?: number, executablePath?: string, userDataDir?: string, args?: string[]}} opts
 */
export async function launch(opts = {}) {
  const headless = opts.headless !== false;
  const executablePath = opts.executablePath || findBrowserExecutable();
  if (!executablePath) {
    throw new Error('No Chromium-based browser found. Set FULLPAGESHOT_CHROME to the browser binary path.');
  }
  if (!existsSync(executablePath)) {
    throw new Error(`Browser binary not found: ${executablePath}`);
  }

  const userDataDir = opts.userDataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'fullpageshot-mcp-'));
  const width = opts.width || 1440;
  const height = opts.height || 900;

  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-client-side-phishing-detection',
    '--hide-scrollbars',
    '--mute-audio',
    `--window-size=${width},${height}`,
  ];
  if (headless) args.push('--headless=new');
  if (Array.isArray(opts.args)) args.push(...opts.args);
  args.push('about:blank');

  let stderr = '';
  const child = spawn(executablePath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.on('data', (d) => { stderr = (stderr + d.toString()).slice(-4000); });
  child.on('error', (e) => { stderr = `${stderr}\nspawn error: ${e.message}`; });

  let port;
  try {
    port = await waitForDevToolsPort(userDataDir, child, SPAWN_WAIT_MS);
  } catch (e) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    throw new Error(`${e.message}${stderr ? `\n${stderr.trim()}` : ''}`);
  }

  const info = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const cdp = await CdpClient.connect(info.webSocketDebuggerUrl);
  return new Browser({ child, cdp, userDataDir, port, executablePath, version: info.Browser });
}

export class Browser {
  constructor({ child, cdp, userDataDir, port, executablePath, version }) {
    this.child = child;
    this.cdp = cdp;
    this.userDataDir = userDataDir;
    this.port = port;
    this.executablePath = executablePath;
    this.version = version;
    this._closing = false;
  }

  /** Open a new page (tab) and attach a flattened CDP session to it. */
  async newPage(url = 'about:blank') {
    const { targetId } = await this.cdp.send('Target.createTarget', { url });
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.cdp, sessionId, targetId);
    await page.enable();
    return page;
  }

  async close() {
    if (this._closing) return;
    this._closing = true;
    try { await this.cdp.send('Browser.close'); } catch { /* may already be gone */ }
    try { this.cdp.close(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      if (this.child.exitCode != null) return resolve();
      const timer = setTimeout(() => { try { this.child.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    try { await fs.rm(this.userDataDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

export class Page {
  constructor(cdp, sessionId, targetId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
    this.targetId = targetId;
  }

  send(method, params = {}) {
    return this.cdp.send(method, params, this.sessionId);
  }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('DOM.enable').catch(() => {});
  }

  /**
   * Navigate and wait for the page load event.
   * @returns {Promise<{url: string, title: string}>}
   */
  async goto(url, { timeoutMs = LOAD_TIMEOUT_MS } = {}) {
    if (!/^[a-z]+:\/\//i.test(url) && !url.startsWith('about:') && !url.startsWith('data:')) {
      url = `https://${url}`;
    }
    let settle;
    const loaded = new Promise((resolve) => { settle = resolve; });
    const off = this.cdp.on('Page.loadEventFired', (_p, sid) => { if (sid === this.sessionId) settle(); });
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) {
      off();
      throw new Error(`Navigation failed: ${nav.errorText}`);
    }
    await Promise.race([loaded, new Promise((r) => setTimeout(r, timeoutMs))]);
    off();
    return this.info();
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.text || 'Evaluation error');
    return result?.value;
  }

  async info() {
    const title = await this.evaluate('document.title').catch(() => '');
    const url = await this.evaluate('location.href').catch(() => '');
    return { url, title };
  }

  async setViewport(width, height, deviceScaleFactor = 1) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile: false });
  }

  /** Scroll through the page once to trigger lazy-loaded content, then return to top. */
  async settle({ step } = {}) {
    await this.evaluate(`(async () => {
      const vh = window.innerHeight || 800;
      const stride = ${step ? Number(step) : 'Math.max(200, Math.floor(vh * 0.9))'};
      const max = Math.max(document.documentElement.scrollHeight || 0, document.body?.scrollHeight || 0);
      for (let y = 0; y < max; y += stride) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); }
      window.scrollTo(0, 0);
      await new Promise(r => setTimeout(r, 120));
    })()`, { awaitPromise: true }).catch(() => {});
  }

  /**
   * Capture a screenshot.
   * @param {{fullPage?: boolean, format?: 'png'|'jpeg'|'webp', quality?: number, maxPx?: number}} opts
   */
  async screenshot({ fullPage = true, format = 'png', quality, maxPx = MAX_CAPTURE_PX } = {}) {
    const params = { format, fromSurface: true, captureBeyondViewport: !!fullPage };
    if (quality != null && format !== 'png') params.quality = quality;

    if (fullPage) {
      const metrics = await this.send('Page.getLayoutMetrics');
      const size = metrics.cssContentSize || metrics.contentSize || {};
      const w = Math.max(1, Math.ceil(size.width || 0));
      const h = Math.max(1, Math.ceil(size.height || 0));
      const scale = Math.min(1, maxPx / w, maxPx / h);
      params.clip = { x: 0, y: 0, width: w, height: h, scale };
      const { data } = await this.send('Page.captureScreenshot', params);
      return {
        buffer: Buffer.from(data, 'base64'),
        format,
        cssWidth: w,
        cssHeight: h,
        scale,
        width: Math.round(w * scale),
        height: Math.round(h * scale),
      };
    }

    const { data } = await this.send('Page.captureScreenshot', params);
    return { buffer: Buffer.from(data, 'base64'), format, scale: 1 };
  }

  async close() {
    try { await this.cdp.send('Target.closeTarget', { targetId: this.targetId }); } catch { /* ignore */ }
  }
}