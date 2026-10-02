#!/usr/bin/env node
// fullpageshot-mcp — Model Context Protocol server (stdio).
// Open a website, capture a full-page screenshot in the background (headless by
// default), and read the image back. Zero dependencies.
//
// Tools:
//   open_url          navigate to a URL (optionally visible)
//   screenshot        capture the page (full page by default) and return the image
//   read_screenshot   read a previously saved screenshot back as image content
//   close_browser     shut down the headless browser
//   browser_status    report browser / output-directory state
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (MCP stdio).
// All diagnostics go to stderr so stdout stays a clean protocol stream.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { launch, findBrowserExecutable } from './browser.mjs';
import { imageDimensions } from './png.mjs';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const log = (...parts) =>
  process.stderr.write('[fullpageshot-mcp] ' + parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n');

const DEFAULT_OUTPUT_DIR = process.env.FULLPAGESHOT_OUT || path.join(os.tmpdir(), 'fullpageshot-mcp');

const state = {
  browser: null,
  page: null,
  headless: process.env.FULLPAGESHOT_HEADLESS === '0' ? false : true,
  outputDir: DEFAULT_OUTPUT_DIR,
};

// ---------------------------------------------------------------- browser ----

async function closeBrowser() {
  const { page, browser } = state;
  state.page = null;
  state.browser = null;
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
}

async function ensureBrowser(opts = {}) {
  const headless = opts.headless !== undefined ? !!opts.headless : state.headless;
  if (state.browser && headless !== state.headless) await closeBrowser();
  if (!state.browser) {
    state.browser = await launch({ headless, width: opts.width, height: opts.height });
    state.headless = headless;
    log(`launched ${state.browser.version} (headless=${headless})`);
  }
  return state.browser;
}

async function ensurePage(opts = {}) {
  const browser = await ensureBrowser(opts);
  if (!state.page) state.page = await browser.newPage('about:blank');
  if (opts.width && opts.height) await state.page.setViewport(opts.width, opts.height);
  return state.page;
}

// ----------------------------------------------------------------- output ----

const EXT_BY_FORMAT = { png: 'png', jpeg: 'jpg', webp: 'webp' };
const MIME_BY_FORMAT = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

async function resolveOutputPath(requested, format) {
  const ext = EXT_BY_FORMAT[format] || 'png';
  if (requested) {
    const abs = path.resolve(requested);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    return abs;
  }
  await fs.mkdir(state.outputDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(state.outputDir, `fullpageshot-${stamp}.${ext}`);
}

const mimeFromPath = (file, dims) =>
  MIME_BY_FORMAT[dims?.format] || MIME_BY_FORMAT[path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg')] || 'application/octet-stream';

const text = (t) => ({ type: 'text', text: t });

// ------------------------------------------------------------------ tools ----

async function toolOpenUrl(args) {
  const page = await ensurePage(args);
  const info = await page.goto(args.url, { timeoutMs: args.timeoutMs });
  if (args.settle !== false) await page.settle();
  return {
    content: [text([
      `Opened: ${info.url}`,
      `Title: ${info.title || '(none)'}`,
      `Mode: ${state.headless ? 'headless (background)' : 'visible window'}`,
      `Browser: ${state.browser.version}`,
    ].join('\n'))],
  };
}

async function toolScreenshot(args) {
  const page = await ensurePage(args);
  if (args.url) await page.goto(args.url, { timeoutMs: args.timeoutMs });
  if (args.settle !== false) await page.settle();

  const format = args.format || 'png';
  const shot = await page.screenshot({
    fullPage: args.fullPage !== false,
    format,
    quality: args.quality,
    maxPx: args.maxPx,
  });

  const file = await resolveOutputPath(args.path, format);
  await fs.writeFile(file, shot.buffer);

  const dims = imageDimensions(shot.buffer) || {};
  const info = await page.info();
  const meta = {
    path: file,
    url: info.url,
    title: info.title,
    format,
    bytes: shot.buffer.length,
    width: dims.width ?? shot.width,
    height: dims.height ?? shot.height,
    cssWidth: shot.cssWidth,
    cssHeight: shot.cssHeight,
    scale: shot.scale,
    fullPage: args.fullPage !== false,
  };

  const content = [text(`Screenshot saved: ${file}\n${JSON.stringify(meta, null, 2)}`)];
  if (args.read !== false) {
    content.push({ type: 'image', data: shot.buffer.toString('base64'), mimeType: MIME_BY_FORMAT[format] || 'image/png' });
  }
  return { content, structuredContent: meta };
}

async function toolReadScreenshot(args) {
  const file = path.resolve(args.path);
  const buffer = await fs.readFile(file);
  const dims = imageDimensions(buffer) || {};
  const mime = mimeFromPath(file, dims);
  const summary = `Screenshot: ${file}\n${JSON.stringify({ bytes: buffer.length, width: dims.width, height: dims.height, format: dims.format }, null, 2)}`;
  return {
    content: [text(summary), { type: 'image', data: buffer.toString('base64'), mimeType: mime }],
    structuredContent: { path: file, bytes: buffer.length, width: dims.width, height: dims.height, format: dims.format },
  };
}

async function toolCloseBrowser() {
  const had = !!state.browser;
  const version = state.browser?.version;
  await closeBrowser();
  return { content: [text(had ? `Closed browser (${version}).` : 'No browser was running.')] };
}

async function toolBrowserStatus() {
  const info = {
    running: !!state.browser,
    headless: state.headless,
    version: state.browser?.version || null,
    executablePath: state.browser?.executablePath || findBrowserExecutable(),
    outputDir: state.outputDir,
  };
  return { content: [text(JSON.stringify(info, null, 2))], structuredContent: info };
}

const TOOLS = [
  {
    name: 'open_url',
    description: 'Open a website in a controlled Chromium browser. Runs headless (background) by default; set headless=false for a visible window.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (https:// is assumed if no scheme is given).' },
        headless: { type: 'boolean', description: 'Run without a visible window. Default true.' },
        width: { type: 'number', description: 'Viewport width in CSS px.' },
        height: { type: 'number', description: 'Viewport height in CSS px.' },
        settle: { type: 'boolean', description: 'Scroll through the page first to trigger lazy content. Default true.' },
        timeoutMs: { type: 'number', description: 'Navigation timeout in ms. Default 30000.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'screenshot',
    description: 'Capture a full-page screenshot (default) of the current page or of a URL. Saves a PNG/JPEG/WebP to disk and returns the image so it can be read.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'If set, navigate here before capturing. Otherwise captures the current page.' },
        fullPage: { type: 'boolean', description: 'Capture the whole page beyond the viewport. Default true.' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Image format. Default png.' },
        quality: { type: 'number', description: '0-100, JPEG/WebP only.' },
        width: { type: 'number', description: 'Viewport width in CSS px.' },
        height: { type: 'number', description: 'Viewport height in CSS px.' },
        settle: { type: 'boolean', description: 'Scroll through the page first to trigger lazy content. Default true.' },
        path: { type: 'string', description: 'Output file path. Defaults to the system temp dir.' },
        maxPx: { type: 'number', description: 'Max image dimension; larger pages are scaled down. Default 16384.' },
        read: { type: 'boolean', description: 'Return the image bytes in the response. Default true.' },
        timeoutMs: { type: 'number', description: 'Navigation timeout in ms.' },
      },
    },
  },
  {
    name: 'read_screenshot',
    description: 'Read a previously saved screenshot file back as image content.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to a PNG/JPEG/WebP/GIF file.' } },
      required: ['path'],
    },
  },
  {
    name: 'close_browser',
    description: 'Shut down the controlled browser and clean up its temporary profile.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_status',
    description: 'Report whether the browser is running, whether it is headless, its version, and the screenshot output directory.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const HANDLERS = {
  open_url: toolOpenUrl,
  screenshot: toolScreenshot,
  read_screenshot: toolReadScreenshot,
  close_browser: toolCloseBrowser,
  browser_status: toolBrowserStatus,
};

async function callTool(name, args) {
  const handler = HANDLERS[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler(args || {});
}

// -------------------------------------------------------------- MCP loop ----

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(message) {
  const { id, method, params } = message;

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fullpageshot-mcp', version: VERSION },
      },
    });
    return;
  }

  if (typeof method === 'string' && method.startsWith('notifications/')) return;

  if (method === 'ping') { send({ jsonrpc: '2.0', id, result: {} }); return; }

  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    return;
  }

  if (method === 'tools/call') {
    try {
      const result = await callTool(params?.name, params?.arguments);
      send({ jsonrpc: '2.0', id, result });
    } catch (e) {
      log('tool error', params?.name, e?.message || String(e));
      send({ jsonrpc: '2.0', id, result: { content: [text(`Error: ${e?.message || e}`)], isError: true } });
    }
    return;
  }

  if (id != null) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--version') || argv.includes('-v')) { process.stdout.write(VERSION + '\n'); return; }
  if (argv.includes('--list-tools')) { process.stdout.write(JSON.stringify(TOOLS, null, 2) + '\n'); return; }
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write([
      'fullpageshot-mcp — MCP server for website full-page screenshots',
      '',
      'Usage: fullpageshot-mcp            (serve MCP over stdio)',
      '       fullpageshot-mcp --list-tools',
      '       fullpageshot-mcp --version',
      '',
      'Env: FULLPAGESHOT_CHROME=/path/to/chrome  override browser binary',
      '     FULLPAGESHOT_HEADLESS=0              show a visible window',
      '     FULLPAGESHOT_OUT=/path/dir           screenshot output directory',
      '',
    ].join('\n'));
    return;
  }

  let buffer = '';
  let chain = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { log('ignored non-JSON line'); continue; }
      chain = chain.then(() => handle(message)).catch((e) => log('handler error', e?.message || String(e)));
    }
  });

  const shutdown = async () => {
    await chain.catch(() => {}); // let any in-flight capture finish before exiting
    await closeBrowser();
    process.exit(0);
  };
  process.stdin.on('end', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  log(`ready (v${VERSION}); browser=${findBrowserExecutable() || 'not found'}`);
}

main();