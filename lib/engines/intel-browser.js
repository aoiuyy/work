import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { findBraveExecutable, markProfileExitedCleanly, CdpConnection } from './brave-player.js';

const PRIVATE_IP_RE = /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc00:|fd|fe80:)/i;

/**
 * Validates that an Intel browser URL uses http/https and does not target local or private network hosts.
 */
export function validatePublicUrl(rawUrl) {
  const normalized = /^https?:\/\//i.test(String(rawUrl || '').trim())
    ? String(rawUrl).trim()
    : `https://${String(rawUrl || '').trim()}`;
  const parsed = new URL(normalized);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || PRIVATE_IP_RE.test(host)) {
    throw new Error('Blocked private or local host');
  }
  return parsed;
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const DEFAULT_WIDTH = 1024;
const DEFAULT_HEIGHT = 720;

/**
 * Off-screen persistent Brave CDP browser for live real-time social browsing with user cookies.
 */
export class IntelBrowser {
  constructor(options = {}) {
    this.executable = options.executable !== undefined ? options.executable : findBraveExecutable();
    const baseDir = process.env.LOCALAPPDATA || path.join(process.cwd(), 'temp');
    this.profileDirectory = options.profileDirectory || path.join(baseDir, 'DSH-Work', 'brave-intel-profile');
    this.width = DEFAULT_WIDTH;
    this.height = DEFAULT_HEIGHT;
    this.process = null;
    this.port = null;
    this.targetId = null;
    this.connection = null;
    this.startPromise = null;
    this.snapshotPromise = null;
    this.lifecycleGeneration = 0;
    this.currentUrl = 'https://www.facebook.com/';
    this.currentTitle = 'Intel Live Browser';
    this.darkMode = false;
  }

  status() {
    return {
      installed: Boolean(this.executable),
      connected: Boolean(this.connection),
      url: this.currentUrl,
      title: this.currentTitle,
      width: this.width,
      height: this.height,
      darkMode: this.darkMode,
      error: this.executable ? null : 'Brave/Chrome/Edge is not installed on this machine',
    };
  }

  async ensureConnected(initialUrl = this.currentUrl) {
    if (!this.executable) throw new Error('Brave/Chrome/Edge is required for Live Social Browser');
    if (this.connection) return this.connection;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.launch(initialUrl).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async launch(initialUrl) {
    const gen = this.lifecycleGeneration;
    const safeUrl = validatePublicUrl(initialUrl).href;
    fs.mkdirSync(this.profileDirectory, { recursive: true });
    markProfileExitedCleanly(this.profileDirectory);
    const activePortFile = path.join(this.profileDirectory, 'DevToolsActivePort');
    try { fs.unlinkSync(activePortFile); } catch {}

    const args = [
      `--user-data-dir=${this.profileDirectory}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      '--disable-background-mode',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
      '--window-position=-32000,-32000',
      `--window-size=${this.width},${this.height}`,
      '--new-window',
      safeUrl,
    ];

    this.process = spawn(this.executable, args, { windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 20000;
    let port = null;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(activePortFile, 'utf8');
        const parsed = Number(raw.split(/\r?\n/)[0]);
        if (Number.isInteger(parsed) && parsed > 0) { port = parsed; break; }
      } catch {}
      if (this.process?.exitCode !== null) throw new Error('Intel browser closed prematurely');
      await wait(150);
    }
    if (!port) throw new Error('Intel browser DevTools port unavailable');
    if (gen !== this.lifecycleGeneration) return null;
    this.port = port;

    const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
    let target = targets.find(t => t.type === 'page' && /^https?:/i.test(t.url || '')) || targets.find(t => t.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('Could not attach to Intel browser tab');
    this.targetId = target.id;
    this.connection = new CdpConnection(target.webSocketDebuggerUrl);
    await this.connection.connect();
    await this.connection.call('Page.enable');
    await this.connection.call('Runtime.enable');
    await this.connection.call('Emulation.setDeviceMetricsOverride', {
      width: this.width,
      height: this.height,
      deviceScaleFactor: 2,
      mobile: false,
    }).catch(() => {});
    this.currentUrl = safeUrl;
    return this.connection;
  }

  async navigate(rawUrl) {
    const safeUrl = validatePublicUrl(rawUrl).href;
    const conn = await this.ensureConnected(safeUrl);
    await conn.call('Page.navigate', { url: safeUrl });
    this.currentUrl = safeUrl;
    await wait(250);
    if (this.darkMode) await this.applyDarkMode(true).catch(() => {});
    return this.snapshot();
  }

  async resize(width, height) {
    const nextW = Math.max(360, Math.min(1920, Math.round(Number(width) || DEFAULT_WIDTH)));
    const nextH = Math.max(240, Math.min(1440, Math.round(Number(height) || DEFAULT_HEIGHT)));
    if (Math.abs(nextW - this.width) < 12 && Math.abs(nextH - this.height) < 12) {
      return { width: this.width, height: this.height };
    }
    this.width = nextW;
    this.height = nextH;
    if (this.connection) {
      await this.connection.call('Emulation.setDeviceMetricsOverride', {
        width: this.width,
        height: this.height,
        deviceScaleFactor: 2,
        mobile: false,
      }).catch(() => {});
    }
    return { width: this.width, height: this.height };
  }

  async applyDarkMode(enabled) {
    this.darkMode = Boolean(enabled);
    if (!this.connection) return { darkMode: this.darkMode };
    const expr = this.darkMode
      ? `(() => { let s = document.getElementById('__wk_intel_dark'); if (!s) { s = document.createElement('style'); s.id = '__wk_intel_dark'; s.textContent = 'html { filter: invert(0.92) hue-rotate(180deg) !important; background: #0c0e12 !important; } img, video, picture, canvas, svg { filter: invert(1) hue-rotate(180deg) !important; }'; (document.head || document.documentElement).appendChild(s); } })()`
      : `(() => { document.getElementById('__wk_intel_dark')?.remove(); })()`;
    await this.connection.call('Runtime.evaluate', { expression: expr }, 4000).catch(() => {});
    return { darkMode: this.darkMode };
  }

  async clipPage() {
    if (!this.connection) return { title: this.currentTitle, url: this.currentUrl, text: '' };
    const res = await this.connection.call('Runtime.evaluate', {
      expression: `(() => {
        const sel = window.getSelection ? String(window.getSelection()).trim() : '';
        const body = document.body ? document.body.innerText.trim() : '';
        return { title: document.title || '', url: location.href || '', text: (sel || body).slice(0, 6000) };
      })()`,
      returnByValue: true,
    }, 5000).catch(() => null);
    return res?.result?.value || { title: this.currentTitle, url: this.currentUrl, text: '' };
  }

  async snapshot() {
    if (!this.connection) {
      return { connected: false, image: null, url: this.currentUrl, title: this.currentTitle, width: this.width, height: this.height, darkMode: this.darkMode };
    }
    if (this.snapshotPromise) return this.snapshotPromise;
    this.snapshotPromise = (async () => {
      try {
        if (this.darkMode) await this.applyDarkMode(true);
        const [shot, meta] = await Promise.all([
          this.connection.call('Page.captureScreenshot', { format: 'png' }, 8000),
          this.connection.call('Runtime.evaluate', {
            expression: '({ url: location.href, title: document.title })',
            returnByValue: true,
          }, 5000).catch(() => null),
        ]);
        const info = meta?.result?.value;
        if (info?.url && /^https?:/i.test(info.url)) this.currentUrl = info.url;
        if (info?.title) this.currentTitle = info.title;
        return {
          connected: true,
          image: shot?.data ? `data:image/png;base64,${shot.data}` : null,
          url: this.currentUrl,
          title: this.currentTitle,
          width: this.width,
          height: this.height,
          darkMode: this.darkMode,
        };
      } catch {
        return { connected: Boolean(this.connection), image: null, url: this.currentUrl, title: this.currentTitle, width: this.width, height: this.height, darkMode: this.darkMode };
      }
    })().finally(() => { this.snapshotPromise = null; });
    return this.snapshotPromise;
  }

  async input(action = {}) {
    const conn = await this.ensureConnected(this.currentUrl);
    const x = Math.max(0, Math.min(this.width - 1, Math.round(Number(action.x) || 0)));
    const y = Math.max(0, Math.min(this.height - 1, Math.round(Number(action.y) || 0)));

    if (action.type === 'click') {
      await conn.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
      await conn.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await conn.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    } else if (action.type === 'wheel') {
      await conn.call('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: Number(action.deltaX) || 0,
        deltaY: Number(action.deltaY) || 240,
      });
    } else if (action.type === 'type' && typeof action.text === 'string' && action.text.length > 0) {
      await conn.call('Input.insertText', { text: action.text.slice(0, 2000) });
    } else if (action.type === 'key' && typeof action.key === 'string') {
      const special = {
        Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 },
        Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
        Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
        Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
        ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
        ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
        ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
        ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
      }[action.key];
      if (special) {
        await conn.call('Input.dispatchKeyEvent', { type: 'keyDown', ...special });
        await conn.call('Input.dispatchKeyEvent', { type: 'keyUp', ...special });
      } else if (action.key.length === 1) {
        await conn.call('Input.insertText', { text: action.key });
      }
    } else if (action.type === 'back' || action.type === 'forward') {
      const history = await conn.call('Page.getNavigationHistory');
      const targetIndex = history.currentIndex + (action.type === 'back' ? -1 : 1);
      const entry = history.entries?.[targetIndex];
      if (entry) await conn.call('Page.navigateToHistoryEntry', { entryId: entry.id });
    } else if (action.type === 'reload') {
      await conn.call('Page.reload', { ignoreCache: false });
    }

    await wait(120);
    return this.snapshot();
  }

  async stop() {
    this.lifecycleGeneration++;
    const proc = this.process;
    try { await this.connection?.call('Browser.close', {}, 1500); } catch {}
    this.connection?.close();
    this.connection = null;
    this.targetId = null;
    this.port = null;
    this.process = null;
    if (proc && proc.exitCode === null) {
      try { proc.kill(); } catch {}
    }
    return { ok: true };
  }
}
