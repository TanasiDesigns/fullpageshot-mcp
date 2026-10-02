# fullpageshot-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an agent the ability to:

1. **open a website** (`open_url`)
2. **take a screenshot of it** (`screenshot`) — full-page by default
3. **read the screenshot** back as an image (`read_screenshot`)

Capture runs **in the background by default** (headless Chromium), so it needs no open window and no browser extension. It drives a Chromium-based browser you already have via the Chrome DevTools Protocol — **zero npm dependencies**.

> Companion to the [FullPageShot](../FullPageScreenShot) browser extension. The extension is for humans clicking the toolbar; this server is for agents and scripts.

## Requirements

| | |
|---|---|
| Node.js | **>= 22** (uses the built-in `WebSocket` and `fetch`; Node 24 tested) |
| Browser | Any Chromium-based browser: **Google Chrome, Brave, Chromium, Microsoft Edge** |
| OS | macOS, Linux, Windows |
| Dependencies | **none** |

The server finds a browser automatically. Override with `FULLPAGESHOT_CHROME=/path/to/browser`.

## Install

```bash
git clone https://github.com/TanasiDesigns/fullpageshot-mcp
cd fullpageshot-mcp
node src/server.mjs --version      # sanity check, no install step needed
```

Or run it straight from a checkout in any MCP client config (below). No `npm install` is required.

## Add it to an MCP client

Generic stdio configuration (Claude Desktop, Cursor, Cline, Continue, pi, etc.):

```json
{
  "mcpServers": {
    "fullpageshot": {
      "command": "node",
      "args": ["/absolute/path/to/fullpageshot-mcp/src/server.mjs"]
    }
  }
}
```

With the optional bin link:

```json
{
  "mcpServers": {
    "fullpageshot": { "command": "fullpageshot-mcp" }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `open_url` | Navigate to a URL. `headless:false` opens a visible window. Returns the final URL + title. |
| `screenshot` | Capture the current page, or a `url` you pass. Full-page by default. Saves PNG/JPEG/WebP to disk **and** returns the image. |
| `read_screenshot` | Read a saved screenshot file back as image content. |
| `close_browser` | Shut the browser down and remove its throwaway profile. |
| `browser_status` | Show running/headless/version/output-dir state. |

### Example agent prompts

- "Open `https://example.com` and screenshot it."
- "Take a full-page screenshot of `https://en.wikipedia.org/wiki/Web_browser` and tell me what the infobox says."
- "Screenshot `https://stripe.com/pricing` at 1440×900 and read it back."
- "Capture `https://github.com` and crop-check the footer." (capture, then `read_screenshot`)

## Background capture

Capture is **headless by default** (`--headless=new`) so it works with no visible window:

- `screenshot({ url, headless: true })` → background, no window.
- `open_url({ url, headless: false })` → visible window (useful for debugging).
- Env `FULLPAGESHOT_HEADLESS=0` forces a visible window for every call.

Each run uses a throwaway profile under the system temp dir, so it never touches your real browser profile or logins.

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `FULLPAGESHOT_CHROME` | auto-detected | Path to the browser binary. |
| `FULLPAGESHOT_HEADLESS` | `1` | `0` shows a visible window. |
| `FULLPAGESHOT_OUT` | temp dir | Where screenshots are saved. |

## How it works

```
MCP stdio  ->  fullpageshot-mcp  ->  launches Chromium (headless)
                                   ->  CDP over WebSocket
                                       Target.createTarget
                                       Page.navigate
                                       Page.getLayoutMetrics
                                       Page.captureScreenshot{captureBeyondViewport}
                                   ->  PNG on disk + base64 image back to the agent
```

Full-page capture uses `captureBeyondViewport` with a clip sized to the page's content, scaled down if it would exceed the 16384 px screenshot ceiling. `screenshot` also scrolls the page once (`settle`) to trigger lazy-loaded content before measuring.

## Security & privacy

- Runs entirely locally. No telemetry, no accounts, no network calls except the pages you ask it to open.
- Never attaches to your everyday browser or its profile — it launches a separate throwaway instance.
- The only "remote control" surface is the browser it starts itself.

## Compatibility

Tested with Brave **154.0.8037.93** (Chromium 154) on macOS, headless. The CDP methods used (`Target.*`, `Page.navigate`, `Page.getLayoutMetrics`, `Page.captureScreenshot`) are long-stable and supported by Chromium 100+; Chrome/Brave/Edge/Chromium all work.

## License

**MIT** — see [LICENSE](LICENSE). Do whatever you want with it: use, modify, fork, sell, ship in your own product. Just keep the copyright notice.