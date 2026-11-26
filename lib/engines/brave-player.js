import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function isYouTubeUrl(rawUrl) {
  try {
    const url = new URL(String(rawUrl || ''));
    return url.protocol === 'https:' && (YOUTUBE_HOSTS.has(url.hostname.toLowerCase()) || url.hostname.toLowerCase().endsWith('.youtube.com'));
  } catch {
    return false;
  }
}


/**
 * Extracts a top-level JSON object starting at `startIndex` (which must point to '{')
 * while properly handling strings and escape sequences (immune to semicolons inside titles).
 */
export function extractBalancedJsonObject(source, startIndex) {
  if (startIndex < 0 || source[startIndex] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return source.slice(startIndex, i + 1);
    }
  }
  return null;
}

export function formatCompactCount(raw) {
  const s = String(raw || '').trim();
  if (!s || /^no\s+views?$/i.test(s)) return '';
  const stripped = s
    .replace(/\b(?:views?|watching|subscribers?|lượt xem|người đang xem|người đăng ký)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return '';
  if (/^\d[\d,.]*[KMBT]$/i.test(stripped)) return stripped.toUpperCase();
  const digits = stripped.replace(/[,\s]/g, '');
  if (/^\d+$/.test(digits)) {
    const n = Number(digits);
    if (n >= 1e9) return `${(n / 1e9).toFixed(1).replace(/\.0$/, '')}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
    return String(n);
  }
  return stripped;
}

export function formatCompactTime(raw) {
  const s = String(raw || '').trim().replace(/^(?:Streamed|Premiered)\s+/i, '');
  if (!s) return '';
  return s
    .replace(/\b(\d+)\s*seconds?\s+ago\b/i, '$1s ago')
    .replace(/\b(\d+)\s*minutes?\s+ago\b/i, '$1m ago')
    .replace(/\b(\d+)\s*hours?\s+ago\b/i, '$1h ago')
    .replace(/\b(\d+)\s*days?\s+ago\b/i, '$1d ago')
    .replace(/\b(\d+)\s*weeks?\s+ago\b/i, '$1w ago')
    .replace(/\b(\d+)\s*months?\s+ago\b/i, '$1mo ago')
    .replace(/\b(\d+)\s*years?\s+ago\b/i, '$1y ago');
}

const YOUTUBE_SP_SORT = { relevance: 0, rating: 1, date: 2, views: 3 };
const YOUTUBE_SP_UPLOAD = { any: 0, hour: 1, today: 2, week: 3, month: 4, year: 5 };
const YOUTUBE_SP_TYPE = { all: 0, video: 1, channel: 2, playlist: 3 };
const YOUTUBE_SP_DURATION = { any: 0, short: 1, medium: 3, long: 2 };

export function parseDurationSeconds(raw) {
  const s = String(raw || '').trim();
  if (!s || !/^\d+(?::\d{1,2}){1,2}$/.test(s)) return null;
  const parts = s.split(':').map(Number);
  return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
}

export function buildSearchSp(filters = {}) {
  const type = YOUTUBE_SP_TYPE[filters?.type] ?? 0;
  const sort = YOUTUBE_SP_SORT[filters?.sortBy] ?? 0;
  const upload = (type === 2 || type === 3) ? 0 : (YOUTUBE_SP_UPLOAD[filters?.uploadDate] ?? 0);
  const duration = (type === 2 || type === 3) ? 0 : (YOUTUBE_SP_DURATION[filters?.duration] ?? 0);
  const sub = [];
  if (upload) sub.push(0x08, upload);
  if (type) sub.push(0x10, type);
  if (duration) sub.push(0x18, duration);
  if (!sort && !sub.length) return '';
  const bytes = [];
  if (sort) bytes.push(0x08, sort);
  if (sub.length) bytes.push(0x12, sub.length, ...sub);
  return Buffer.from(bytes).toString('base64');
}

export function extractSearchResults(data, options = {}) {
  const results = [];
  const seen = new Set();
  const includeChannels = Boolean(options.includeChannels);
  const includePlaylists = Boolean(options.includePlaylists);
  const defaultAuthor = options.defaultAuthor || '';
  const text = value => typeof value === 'string' ? value : value?.content || value?.simpleText || value?.runs?.map(r => r.text).join('') || '';
  const normalizeThumb = url => {
    const clean = String(url || '').trim();
    return clean.startsWith('//') ? `https:${clean}` : clean;
  };
  function visit(node) {
    if (!node || typeof node !== 'object' || results.length >= 25) return;
    const channel = node.channelRenderer;
    if (channel) {
      if (includeChannels) {
        const cid = channel.channelId;
        const title = text(channel.title);
        const subText = text(channel.subscriberCountText);
        const vidText = text(channel.videoCountText);
        const handle = subText.startsWith('@') ? subText : (vidText.startsWith('@') ? vidText : '');
        const subRaw = /subscriber/i.test(vidText) ? vidText : (/subscriber/i.test(subText) ? subText : '');
        const subscribers = formatCompactCount(subRaw);
        const channelPath = channel.navigationEndpoint?.commandMetadata?.webCommandMetadata?.url || (cid ? `/channel/${cid}` : '');
        const thumbs = channel.thumbnail?.thumbnails || [];
        const thumbnail = normalizeThumb(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url);
        if (cid && title && channelPath && !seen.has(`ch:${cid}`)) {
          seen.add(`ch:${cid}`);
          results.push({
            type: 'channel',
            id: cid,
            title,
            handle,
            subscribers,
            author: handle || title,
            thumbnail,
            channelPath,
            url: `https://www.youtube.com${channelPath}`,
          });
        }
      }
      return;
    }
    const playlist = node.playlistRenderer;
    if (playlist) {
      if (includePlaylists && playlist.playlistId) {
        const pid = playlist.playlistId;
        const title = text(playlist.title);
        const author = text(playlist.shortBylineText || playlist.longBylineText) || 'YouTube';
        const videoCount = text(playlist.videoCountText || playlist.videoCount);
        const thumbs = playlist.thumbnails?.[0]?.thumbnails || [];
        const thumbnail = normalizeThumb(thumbs[thumbs.length - 1]?.url || thumbs[0]?.url);
        if (title && !seen.has(`pl:${pid}`)) {
          seen.add(`pl:${pid}`);
          results.push({
            type: 'playlist',
            id: pid,
            title,
            author,
            videoCount,
            duration: videoCount ? `${videoCount} videos` : 'Playlist',
            thumbnail,
            url: `https://www.youtube.com/playlist?list=${encodeURIComponent(pid)}`,
          });
        }
      }
      return;
    }
    const lockup = node.lockupViewModel;
    const video = node.videoRenderer;
    if (lockup || video) {
      if (lockup?.contentType === 'LOCKUP_CONTENT_TYPE_PLAYLIST') {
        if (includePlaylists && lockup.contentId && !seen.has(`pl:${lockup.contentId}`)) {
          const pid = lockup.contentId;
          const meta = lockup.metadata?.lockupMetadataViewModel;
          const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
          const title = text(meta?.title);
          const author = text(rows[0]?.metadataParts?.[0]?.text) || 'YouTube';
          let badgeText = '';
          function plBadge(v) {
            if (!v || typeof v !== 'object') return;
            if (v.thumbnailBadgeViewModel) badgeText ||= text(v.thumbnailBadgeViewModel.text);
            for (const c of Object.values(v)) plBadge(c);
          }
          plBadge(lockup.contentImage);
          const sources = lockup.contentImage?.collectionThumbnailViewModel?.primaryThumbnail?.thumbnailViewModel?.image?.sources || [];
          const thumbnail = normalizeThumb(sources[sources.length - 1]?.url || sources[0]?.url);
          if (title) {
            seen.add(`pl:${pid}`);
            results.push({
              type: 'playlist',
              id: pid,
              title,
              author,
              duration: badgeText || 'Playlist',
              thumbnail,
              url: `https://www.youtube.com/playlist?list=${encodeURIComponent(pid)}`,
            });
          }
        }
        return;
      }
      const id = lockup?.contentId || video?.videoId;
      const meta = lockup?.metadata?.lockupMetadataViewModel;
      const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
      const title = text(meta?.title || video?.title);
      const firstPart0 = rows[0]?.metadataParts?.[0];
      const singleRowStats = rows.length === 1 && (firstPart0?.leadingIcon?.name === 'PLAY_ARROW_OUTLINED' || (rows[0]?.metadataParts?.length || 0) >= 2);
      const author = singleRowStats
        ? (defaultAuthor || 'YouTube')
        : (text(firstPart0?.text || video?.ownerText || video?.shortBylineText) || defaultAuthor || 'YouTube');
      const statsRow = singleRowStats ? rows[0] : rows[1];
      const metaParts = (statsRow?.metadataParts || []).map(p => text(p.text)).filter(Boolean);
      const rawViews = text(video?.shortViewCountText || video?.viewCountText) || metaParts[0] || '';
      const rawPublished = text(video?.publishedTimeText) || metaParts[1] || '';
      const views = formatCompactCount(rawViews);
      const published = formatCompactTime(rawPublished);
      let duration = text(video?.lengthText);
      function badge(value) {
        if (!value || typeof value !== 'object') return;
        if (value.thumbnailBadgeViewModel) duration ||= text(value.thumbnailBadgeViewModel.text);
        for (const child of Object.values(value)) badge(child);
      }
      if (lockup) badge(lockup.contentImage);
      const isLive = /watching/i.test(rawViews) || Boolean(video?.badges?.some(b => /live/i.test(b.metadataBadgeRenderer?.label || '')));
      if (!duration && isLive) duration = 'LIVE';
      if (/^[A-Za-z0-9_-]{11}$/.test(id || '') && title && !seen.has(id)
          && (!lockup?.contentType || lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
        seen.add(id);
        results.push({ type: 'video', id, title, author, views, published, duration, isLive, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, url: `https://www.youtube.com/watch?v=${id}` });
      }
      return;
    }
    for (const child of Object.values(node)) visit(child);
  }
  visit(data?.contents || data);
  return results;
}

export function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const clean = input.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(clean)) return clean;
  try {
    const url = new URL(clean);
    const pathMatch = url.pathname.match(/\/(?:shorts|embed|live)\/([^/?#]+)/);
    if (pathMatch) return pathMatch[1];
    if (url.hostname === 'youtu.be') return url.pathname.slice(1).split('/')[0] || null;
    return url.searchParams.get('v') || null;
  } catch {
    return null;
  }
}

export function findBraveExecutable() {
  if (process.platform !== 'win32') {
    const unixCandidates = [
      '/usr/bin/brave-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/microsoft-edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
    return unixCandidates.find(c => fs.existsSync(c)) || null;
  }
  const progFiles = process.env.PROGRAMFILES;
  const progFilesX86 = process.env['PROGRAMFILES(X86)'];
  const localAppData = process.env.LOCALAPPDATA;

  const candidates = [
    // 1. Brave Browser
    progFiles && path.join(progFiles, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    progFilesX86 && path.join(progFilesX86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
    localAppData && path.join(localAppData, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),

    // 2. Google Chrome
    progFiles && path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    progFilesX86 && path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    localAppData && path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),

    // 3. Microsoft Edge (Guaranteed on Windows 10/11)
    progFilesX86 && path.join(progFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    progFiles && path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    localAppData && path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) || null;
}

export function markProfileExitedCleanly(profileDirectory) {
  try {
    if (!fs.existsSync(profileDirectory)) return 0;
    const profileNames = fs.readdirSync(profileDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || entry.name.startsWith('Profile ')))
      .map((entry) => entry.name);
    let updated = 0;
    for (const profileName of profileNames) {
      const preferencesPath = path.join(profileDirectory, profileName, 'Preferences');
      if (!fs.existsSync(preferencesPath)) continue;
      try {
        const preferences = JSON.parse(fs.readFileSync(preferencesPath, 'utf8'));
        if (preferences.profile?.exit_type === 'Normal' && preferences.profile?.exited_cleanly === true) continue;
        preferences.profile = preferences.profile || {};
        preferences.profile.exit_type = 'Normal';
        preferences.profile.exited_cleanly = true;
        fs.writeFileSync(preferencesPath, JSON.stringify(preferences));
        updated += 1;
      } catch {}
    }
    return updated;
  } catch {
    return 0;
  }
}

export class CdpConnection {
  constructor(webSocketUrl) {
    this.webSocketUrl = webSocketUrl;
    this.socket = null;
    this.sequence = 0;
    this.pending = new Map();
    this.eventHandlers = new Set();
  }

  onEvent(handler) {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('Native WebSocket is required for Brave CDP connection');
    }
    this.socket = new WebSocket(this.webSocketUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Brave connection timed out')), 10000);
      this.socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Could not connect to Brave WebSocket'));
      }, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => this.failPending(new Error('Brave connection closed')));
  }

  handleMessage(rawMessage) {
    let message;
    try { message = JSON.parse(String(rawMessage)); } catch { return; }
    if (!message.id) {
      if (message.method) {
        for (const handler of this.eventHandlers) {
          try { handler(message.method, message.params || {}); } catch {}
        }
      }
      return;
    }
    if (!this.pending.has(message.id)) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message || 'Brave CDP error'));
    else pending.resolve(message.result || {});
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  call(method, params = {}, timeout = 10000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Brave is not connected'));
    }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.socket?.close(); } catch {}
    this.socket = null;
    this.failPending(new Error('Brave connection closed'));
  }
}

export class BravePlayer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.executable = findBraveExecutable();
    const baseDir = process.env.LOCALAPPDATA || path.join(process.cwd(), 'temp');
    this.profileDirectory = options.profileDirectory || path.join(baseDir, 'DSH-Work', 'brave-music-profile');
    this.playlistFile = options.playlistFile || path.join(baseDir, 'DSH-Work', 'playlist.json');
    this.process = null;
    this.port = null;
    this.targetId = null;
    this.connection = null;
    this.startPromise = null;
    this.pollTimer = null;
    this.pollInFlight = false;
    this.replayMode = options.loop ? 'one' : 'off';
    this.loop = this.replayMode === 'one';
    this.queue = null;
    this.generation = 0;
    this.lifecycleGeneration = 0;
    this.intentRevision = 0;
    this.intendedPlay = false;
    this.lastProgressAt = 0;
    this.lastPosition = 0;
    this.lastKickAt = 0;
    this.fallbackAttempted = false;
    this.fallback = null;
    this.fallbackError = null;
    this.readPromise = null;
    this.lastState = null;
    this.lastRequestedUrl = 'https://www.youtube.com/';
    this.oembedCache = new Map();
    this.searchCache = new Map();
    this.videoMode = false;
    this.screencasting = false;
    this.latestFrame = null;
    this.videoShotPromise = null;
    this.unsubCdpEvents = null;
    this.attachedUrl = null;
    this.qualitySeededVideoId = null;
    this.prewarmPromise = null;
  }

  status() {
    return {
      installed: Boolean(this.executable),
      connected: Boolean(this.connection),
      loop: this.loop,
      replayMode: this.replayMode,
      profileDirectory: this.profileDirectory,
      error: this.executable ? null : 'Brave Browser is not installed on this machine',
    };
  }

  async prewarm() {
    if (!this.executable) return this.status();
    if (this.connection) return this.status();
    if (!this.prewarmPromise) {
      this.prewarmPromise = this.start('https://www.youtube.com/')
        .catch(() => {})
        .finally(() => { this.prewarmPromise = null; });
    }
    await this.prewarmPromise;
    return this.status();
  }

  async start(initialUrl = 'https://www.youtube.com/') {
    if (!this.executable) throw new Error('Brave Browser is not installed');
    if (this.connection) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.launch(initialUrl).finally(() => { this.startPromise = null; });
    return this.startPromise;
  }

  async tryReuseExistingPort(activePortFile) {
    try {
      const raw = fs.readFileSync(activePortFile, 'utf8');
      const existingPort = Number(raw.split(/\r?\n/)[0]);
      if (!Number.isInteger(existingPort) || existingPort <= 0) return null;
      const res = await fetch(`http://127.0.0.1:${existingPort}/json/list`, { signal: AbortSignal.timeout(800) });
      if (res.ok) return existingPort;
    } catch {}
    return null;
  }

  async launch(initialUrl) {
    const generation = this.lifecycleGeneration;
    const safeUrl = isYouTubeUrl(initialUrl) ? initialUrl : 'https://www.youtube.com/';
    this.lastRequestedUrl = safeUrl;

    const launchWithProfile = async (profileDir) => {
      fs.mkdirSync(profileDir, { recursive: true });
      markProfileExitedCleanly(profileDir);
      const activePortFile = path.join(profileDir, 'DevToolsActivePort');
      const reusedPort = await this.tryReuseExistingPort(activePortFile);
      if (reusedPort) return reusedPort;
      try { fs.unlinkSync(activePortFile); } catch {}
      const args = [
        `--user-data-dir=${profileDir}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-crash-restore-bubble',
        '--disable-extensions',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-pings',
        '--disable-background-mode',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        '--autoplay-policy=no-user-gesture-required',
        '--window-position=-32000,-32000',
        '--window-size=900,700',
        '--new-window',
        safeUrl,
      ];
      this.process = spawn(this.executable, args, { windowsHide: true, stdio: 'ignore' });
      return await this.waitForPortFile(activePortFile);
    };

    let port;
    try {
      port = await launchWithProfile(this.profileDirectory);
    } catch (err) {
      if (!/closed prematurely|port unavailable/i.test(err.message || '')) throw err;
      const fallbackDir = path.join(path.dirname(this.profileDirectory), `brave-music-session-${process.pid}`);
      port = await launchWithProfile(fallbackDir);
    }
    if (generation !== this.lifecycleGeneration) return;
    this.port = port;
    await this.attachToYouTubePage(safeUrl);
    if (generation !== this.lifecycleGeneration) { this.connection?.close(); this.connection = null; return; }
    this.startPolling();
    this.emit('status', this.status());
  }

  async waitForPortFile(activePortFile) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try {
        const raw = fs.readFileSync(activePortFile, 'utf8');
        const port = Number(raw.split(/\r?\n/)[0]);
        if (Number.isInteger(port) && port > 0) return port;
      } catch {}
      if (this.process?.exitCode !== null) throw new Error('Brave closed prematurely');
      await wait(40);
    }
    throw new Error('Brave remote debugging port unavailable');
  }

  async devToolsRequest(pathname, options = {}) {
    const response = await fetch(`http://127.0.0.1:${this.port}${pathname}`, {
      ...options,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
    return response.json();
  }

  async cleanupOldTabs(keepTargetId = this.targetId) {
    if (!this.port) return;
    try {
      const targets = await this.devToolsRequest('/json/list');
      for (const t of targets) {
        if (t.type === 'page' && t.id && t.id !== keepTargetId) {
          try {
            await this.devToolsRequest(`/json/close/${t.id}`);
          } catch {}
        }
      }
    } catch {}
  }

  async attachToYouTubePage(initialUrl) {
    const targets = await this.devToolsRequest('/json/list');
    let target = targets.find((item) => item.type === 'page' && isYouTubeUrl(item.url));
    if (!target) {
      target = await this.devToolsRequest(`/json/new?${encodeURIComponent(initialUrl)}`, { method: 'PUT' });
    }
    if (!target?.webSocketDebuggerUrl) throw new Error('Could not find YouTube CDP target');
    this.targetId = target.id;
    this.attachedUrl = target.url || initialUrl;
    await this.cleanupOldTabs(this.targetId);
    this.connection?.close();
    this.connection = new CdpConnection(target.webSocketDebuggerUrl);
    await this.connection.connect();
    this.unsubCdpEvents = this.connection.onEvent((method, params) => {
      if (method === 'Page.screencastFrame' && params?.data) {
        this.latestFrame = { data: `data:image/jpeg;base64,${params.data}`, at: Date.now() };
        this.connection?.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
      }
    });
    await Promise.all([
      this.connection.call('Page.enable'),
      this.connection.call('Runtime.enable'),
    ]);
    if (this.videoMode) await this.applyVideoPresentation(true).catch(() => {});
  }

  async applyVideoPresentation(enabled) {
    this.videoMode = Boolean(enabled);
    if (!this.connection) {
      if (!this.videoMode) { this.screencasting = false; this.latestFrame = null; }
      return { videoMode: this.videoMode, screencasting: false };
    }
    if (this.videoMode) {
      await this.connection.call('Emulation.setDeviceMetricsOverride', {
        width: 1280,
        height: 720,
        deviceScaleFactor: 1,
        mobile: false,
      }).catch(() => {});
      await this.evaluate(`(() => {
        const css = [
          'html,body,ytd-app{overflow:hidden!important;background:#000!important;margin:0!important;padding:0!important;width:100vw!important;height:100vh!important;}',
          'ytd-masthead,#masthead-container,#secondary,#below,#related,#comments,#chat,tp-yt-app-drawer,ytd-miniplayer,ytd-popup-container,#guide,ytd-permission-dialog-renderer{display:none!important;}',
          'ytd-app,ytd-page-manager,ytd-watch-flexy,#columns,#primary,#primary-inner,#player,#player-container-outer,#player-container-inner,#player-container,ytd-player,#container{contain:none!important;transform:none!important;filter:none!important;perspective:none!important;will-change:auto!important;margin:0!important;padding:0!important;}',
          '#movie_player{position:fixed!important;inset:0!important;top:0!important;left:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;z-index:2147483647!important;background:#000!important;}',
          '#movie_player .html5-video-container,#movie_player video,#movie_player .html5-main-video{width:100%!important;height:100%!important;left:0!important;top:0!important;object-fit:contain!important;}',
        ].join(' ');
        let style = document.getElementById('__wk_yt_player_focus');
        if (!style) {
          style = document.createElement('style');
          style.id = '__wk_yt_player_focus';
          (document.head || document.documentElement).appendChild(style);
        }
        if (style.textContent !== css) style.textContent = css;
        window.dispatchEvent(new Event('resize'));
        return true;
      })()`).catch(() => {});
      if (!this.screencasting) {
        await this.connection.call('Page.startScreencast', {
          format: 'jpeg',
          quality: 88,
          maxWidth: 1280,
          maxHeight: 720,
          everyNthFrame: 1,
        }).catch(() => {});
        this.screencasting = true;
      }
    } else {
      if (this.screencasting) {
        await this.connection.call('Page.stopScreencast').catch(() => {});
        this.screencasting = false;
      }
      this.latestFrame = null;
      await this.evaluate(`(() => {
        document.getElementById('__wk_yt_player_focus')?.remove();
        return true;
      })()`).catch(() => {});
    }
    return { videoMode: this.videoMode, screencasting: this.screencasting };
  }

  setVideoMode(enabled) {
    return this.applyVideoPresentation(enabled);
  }

  async getVideoFrame() {
    const staleMs = this.intendedPlay ? 55 : 220;
    if (this.videoMode && this.connection && (!this.latestFrame || Date.now() - this.latestFrame.at > staleMs)) {
      if (!this.videoShotPromise) {
        this.videoShotPromise = this.connection.call('Page.captureScreenshot', { format: 'jpeg', quality: 90, optimizeForSpeed: true }, 3000)
          .then(shot => {
            if (shot?.data) this.latestFrame = { data: `data:image/jpeg;base64,${shot.data}`, at: Date.now() };
          })
          .catch(() => {})
          .finally(() => { this.videoShotPromise = null; });
      }
      await this.videoShotPromise;
    }
    return {
      videoMode: this.videoMode,
      connected: Boolean(this.connection),
      frame: this.videoMode ? (this.latestFrame?.data || null) : null,
      at: this.latestFrame?.at || 0,
    };
  }

  async videoInput(action = {}) {
    if (!this.connection) return this.getVideoFrame();
    const x = Math.max(0, Math.min(1279, Math.round(Number(action.x) || 0)));
    const y = Math.max(0, Math.min(719, Math.round(Number(action.y) || 0)));
    if (action.type === 'move') {
      await this.connection.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {});
    } else if (action.type === 'click') {
      await this.connection.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' }).catch(() => {});
      await this.connection.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }).catch(() => {});
      await this.connection.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }).catch(() => {});
      await wait(120);
      const clickedPlaying = await this.evaluate(`(() => { const v = document.querySelector('video'); const p = document.getElementById('movie_player'); const ps = Number(p?.getPlayerState?.()); return Boolean(v && !v.paused && ps !== 2); })()`).catch(() => null);
      if (typeof clickedPlaying === 'boolean') {
        this.intendedPlay = clickedPlaying;
        this.intentRevision++;
        this.lastProgressAt = Date.now();
      }
      this.latestFrame = null;
    } else if (action.type === 'wheel') {
      await this.connection.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: Number(action.deltaX) || 0, deltaY: Number(action.deltaY) || 120 }).catch(() => {});
    }
    return this.getVideoFrame();
  }

  async ensureConnected(initialUrl) {
    if (!this.connection) await this.start(initialUrl);
    return this.connection;
  }

  async evaluate(expression) {
    const conn = await this.ensureConnected('https://www.youtube.com/');
    const result = await conn.call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'Evaluate command failed');
    }
    return result.result?.value;
  }

  async play(rawUrlOrId, { loop, mode } = {}) {
    let watchUrl = rawUrlOrId;
    const vid = extractVideoId(rawUrlOrId);
    if (vid) {
      watchUrl = `https://www.youtube.com/watch?v=${vid}`;
    }
    if (!isYouTubeUrl(watchUrl)) {
      throw new Error('Invalid YouTube video link or identifier');
    }

    const generation = ++this.generation;
    this.setReplayMode(mode ?? (loop === undefined ? this.replayMode : loop ? 'one' : 'off'));
    this.intendedPlay = true;
    this.intentRevision++;
    this.fallbackAttempted = false;
    this.fallback = null;
    this.fallbackError = null;
    this.lastPosition = 0;
    this.lastProgressAt = Date.now();
    this.lastKickAt = 0;
    this.lastRequestedUrl = watchUrl;
    if (this.qualitySeededVideoId !== vid) this.qualitySeededVideoId = null;
    if (!this.queue) this.loadPlaylist().catch(() => {});
    const wasConnected = Boolean(this.connection);
    const conn = await this.ensureConnected(watchUrl);
    if (generation !== this.generation) return { ok: false, stale: true };
    if (wasConnected) this.cleanupOldTabs(this.targetId).catch(() => {});
    const alreadyLoadingWatch = vid && extractVideoId(this.attachedUrl) === vid;
    this.attachedUrl = null;
    if (!alreadyLoadingWatch) {
      await conn.call('Page.navigate', { url: watchUrl });
    }

    const deadline = Date.now() + 15000;
    let started = false;
    while (Date.now() < deadline) {
      if (generation !== this.generation) return { ok: false, stale: true };
      try {
        const errorCode = await this.evaluate(`Number(document.getElementById('movie_player')?.getPlayerError?.() || 0)`);
        if (generation !== this.generation) return { ok: false, stale: true };
        if (this.fallback || !this.intendedPlay) return { ok: true, url: watchUrl };
        if ([100, 101, 150].includes(errorCode)) {
          if (this.fallbackAttempted && !this.fallbackError) { await wait(120); continue; }
          const failedState = await this.readState();
          await this.tryFallback({ ...failedState, errorCode }, generation);
          return { ok: Boolean(this.fallback), url: watchUrl, fallbackError: this.fallbackError };
        }
        if (!this.intendedPlay) return { ok: true, url: watchUrl };
        const shouldSeedDefaultQuality = !this.videoMode || this.qualitySeededVideoId !== vid;
        const res = await this.evaluate(`(() => {
          const v = document.querySelector('video');
          const p = document.getElementById('movie_player');
          if (!v) return { found: false, active: false };
          v.loop = false;
          if (p) {
            if (${shouldSeedDefaultQuality}) {
              const q = ${this.videoMode ? "'hd720'" : "'tiny'"};
              if (typeof p.setPlaybackQualityRange === 'function') p.setPlaybackQualityRange(q, q);
              if (typeof p.setPlaybackQuality === 'function') p.setPlaybackQuality(q);
            }
            if (typeof p.playVideo === 'function') p.playVideo();
          }
          try { v.play()?.catch?.(() => {}); } catch {}
          const ps = Number(p?.getPlayerState?.());
          if (v.paused && ps !== 1 && ps !== 3) {
            document.querySelector('.ytp-large-play-button')?.click?.();
          }
          return { found: true, active: !v.paused || ps === 1 };
        })()`);
        if (res?.found) {
          started = true;
          if (this.videoMode && vid) this.qualitySeededVideoId = vid;
          if (this.videoMode) await this.applyVideoPresentation(true).catch(() => {});
          if (res.active) break;
        }
      } catch {}
      await wait(100);
    }
    if (!started) throw new Error('YouTube video did not become available for playback');
    return { ok: true, url: watchUrl };
  }

  setReplayMode(mode) {
    if (!['off', 'one', 'all'].includes(mode)) throw new Error('Invalid replay mode');
    this.replayMode = mode;
    this.loop = mode === 'one';
  }

  async command(action, value, mode) {
    if (action === 'loop' || action === 'replayMode') {
      this.setReplayMode(mode ?? (action === 'replayMode' ? value : value ? 'one' : 'off'));
      return true;
    }
    if (action === 'shuffle') {
      this.shuffle = value === undefined ? !this.shuffle : Boolean(value);
      return this.shuffle;
    }
    if (action === 'next' || action === 'previous') return this.advanceQueue(action === 'previous' ? -1 : 1);
    if (action === 'toggle') action = this.intendedPlay ? 'pause' : 'play';
    if (action === 'play' || action === 'pause') {
      this.intendedPlay = action === 'play';
      this.intentRevision++;
      this.lastProgressAt = Date.now();
    }
    const seekSec = Math.max(0, Number(value) || 0);
    if (action === 'seek') {
      this.lastPosition = seekSec;
      this.lastProgressAt = Date.now();
    }
    const rateVal = Math.max(0.25, Math.min(2, Number(value) || 1));
    const commands = {
      play: `(() => { const p = document.querySelector('audio[data-work-audius]') ? null : document.getElementById('movie_player'); const v = document.querySelector('audio[data-work-audius]') || document.querySelector('video'); if (!v && !p) return false; if (typeof p?.playVideo === 'function') p.playVideo(); try { v?.play?.()?.catch?.(() => {}); } catch {} return true; })()`,
      pause: `(() => { const p = document.querySelector('audio[data-work-audius]') ? null : document.getElementById('movie_player'); const v = document.querySelector('audio[data-work-audius]') || document.querySelector('video'); if (!v && !p) return false; if (typeof p?.pauseVideo === 'function') p.pauseVideo(); v?.pause?.(); return true; })()`,
      seek: `(() => { const p = document.querySelector('audio[data-work-audius]') ? null : document.getElementById('movie_player'); const v = document.querySelector('audio[data-work-audius]') || document.querySelector('video'); if (!v && !p) return false; if (typeof p?.seekTo === 'function') p.seekTo(${seekSec}, true); else if (v) v.currentTime = ${seekSec}; return true; })()`,
      volume: `(() => { const p = document.querySelector('audio[data-work-audius]') ? null : document.getElementById('movie_player'); const v = document.querySelector('audio[data-work-audius]') || document.querySelector('video'); if (!v && !p) return false; const vol = ${Math.max(0, Math.min(1, Number(value) || 0))}; if (v) { v.volume = vol; if (vol > 0) v.muted = false; } if (typeof p?.setVolume === 'function') { p.setVolume(Math.round(vol * 100)); if (vol > 0 && typeof p.unMute === 'function') p.unMute(); } return true; })()`,
      rate: `(() => { const p = document.querySelector('audio[data-work-audius]') ? null : document.getElementById('movie_player'); const v = document.querySelector('audio[data-work-audius]') || document.querySelector('video'); if (!v && !p) return false; if (typeof p?.setPlaybackRate === 'function') p.setPlaybackRate(${rateVal}); if (v) v.playbackRate = ${rateVal}; return true; })()`,
    };

    if (!commands[action]) throw new Error(`Unknown player command: ${action}`);
    return Boolean(await this.evaluate(commands[action]));
  }

  readState() {
    if (!this.connection) return Promise.resolve(null);
    if (!this.readPromise) {
      const generation = this.generation;
      this.readPromise = this.readPageState().then(state => generation === this.generation ? state : null).finally(() => { this.readPromise = null; });
    }
    return this.readPromise;
  }

  async readPageState() {
    try {
      const state = await this.evaluate(`(() => {
        const audio = document.querySelector('audio[data-work-audius]');
        const video = audio || document.querySelector('video');
        if (audio) for (const other of document.querySelectorAll('video')) other.pause();
        if (!${this.intendedPlay}) video?.pause?.();
        const player = document.getElementById('movie_player');
        const playerData = player?.getVideoData?.() || {};
        const currentUrl = new URL(location.href);
        const urlVideoId = currentUrl.searchParams.get('v');
        const playerVideoId = playerData.video_id || null;
        const videoId = playerVideoId || urlVideoId;

        // Auto confirm "still watching" dialog
        for (const dialog of document.querySelectorAll('yt-confirm-dialog-renderer, ytd-popup-container tp-yt-paper-dialog')) {
          const text = (dialog.textContent || '').toLowerCase();
          if (text.includes('watching') || text.includes('tiếp tục')) {
            const btn = dialog.querySelector('#confirm-button button, button');
            if (btn) btn.click();
          }
        }

        // Auto-dismiss & fast-skip ads if any slip through
        for (const adBtn of document.querySelectorAll('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, button.ytp-ad-overlay-close-button')) {
          try { adBtn.click(); } catch {}
        }
        if (player?.classList?.contains('ad-showing') && video) {
          video.muted = true;
          if (Number.isFinite(video.duration) && video.duration > 0) video.currentTime = video.duration;
        }

        const title = playerData.title
          || document.querySelector('ytd-watch-metadata h1 yt-formatted-string, h1.title yt-formatted-string')?.textContent?.trim()
          || document.title.replace(/\\s*-\\s*YouTube\\s*$/, '');
        const author = playerData.author
          || document.querySelector('ytd-watch-metadata ytd-channel-name a, #owner ytd-channel-name a')?.textContent?.trim()
          || 'YouTube';
        const artwork = videoId ? 'https://i.ytimg.com/vi/' + videoId + '/hqdefault.jpg' : null;
        const playerState = Number(player?.getPlayerState?.());

        if (video) video.loop = false;

        const rawDuration = Number(video?.duration);
        const liveBadge = document.querySelector('.ytp-live-badge');
        const liveBadgeVisible = Boolean(liveBadge && liveBadge.offsetParent !== null && getComputedStyle(liveBadge).display !== 'none');
        const isLive = Boolean(video && (playerData.isLive || liveBadgeVisible || rawDuration === Infinity || rawDuration > 86400));
        return {
          ready: Boolean(video),
          url: location.href,
          videoId,
          title,
          author,
          artwork,
          isLive,
          duration: isLive ? 0 : (Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0),
          currentTime: Number.isFinite(Number(video?.currentTime)) ? Math.max(0, Number(video.currentTime)) : 0,
          playbackRate: video && Number.isFinite(Number(video.playbackRate)) ? Number(video.playbackRate) : 1,
          volume: video && Number.isFinite(Number(video.volume)) ? Math.max(0, Math.min(1, Number(video.volume))) : 1,
          audioBands: null,
          audioBandsUnavailableReason: 'No safe in-page analyser connected; media capture may be CORS-restricted',
          muted: video ? Boolean(video.muted) : false,
          paused: video ? video.paused : true,
          ended: Boolean(video?.ended || (!audio && playerState === 0 && Number(video?.currentTime) > 0)), 
          errorCode: audio ? Number(audio.error?.code || 0) : Number(player?.getPlayerError?.() || 0),
          playing: Boolean(video && !video.paused && (audio ? video.readyState >= 3 : playerState === 1)),
          buffering: Boolean(video && !video.paused && (audio ? video.readyState < 3 : playerState === 3)),
          loop: ${this.loop ? 'true' : 'false'},
          needsFocusCss: ${this.videoMode} && !document.getElementById('__wk_yt_player_focus'),
        };
      })()`);
      if (this.videoMode && state?.needsFocusCss && this.connection) {
        this.applyVideoPresentation(true).catch(() => {});
      }
      return state ? { ...state, ...(this.fallback || {}), provider: this.fallback ? 'audius' : 'youtube', replayMode: this.replayMode, shuffle: Boolean(this.shuffle), intendedPlay: this.intendedPlay, fallbackError: this.fallbackError, error: this.fallbackError || (state.errorCode ? `Player error ${state.errorCode}` : null) } : null;
    } catch {
      return null;
    }
  }

  async advanceQueue(direction = 1, automatic = false) {
    const queue = this.queue || await this.loadPlaylist();
    if (!queue.length) return false;
    const index = queue.findIndex(t => extractVideoId(t.url || t.id) === extractVideoId(this.lastRequestedUrl));
    let next = index + direction;
    if (automatic && this.replayMode === 'one') next = index;
    if (next < 0 || next >= queue.length) {
      if (this.replayMode !== 'all') { if (automatic) this.intendedPlay = false; return false; }
      next = (next + queue.length) % queue.length;
    }
    const track = queue[next];
    if (!track) return false;
    await this.play(track.url || track.id);
    return true;
  }

  async tryFallback(state, generation = this.generation) {
    if (this.fallbackAttempted || generation !== this.generation || !this.intendedPlay) return;
    this.fallbackAttempted = true;
    const revision = this.intentRevision;
    try {
      const original = this.queue?.find(t => extractVideoId(t.url || t.id) === extractVideoId(this.lastRequestedUrl));
      const query = original?.title || state.title;
      if (!query) throw new Error('No track title available for alternate search');
      const response = await fetch(`https://api.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&limit=1`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error(`Audius HTTP ${response.status}`);
      const track = (await response.json())?.data?.[0];
      if (!track?.id || !/^[A-Za-z0-9_-]+$/.test(track.id) || track.is_streamable !== true || track.is_stream_gated || track.stream_conditions || track.is_download_gated || track.is_available === false) throw new Error('No playable free Audius alternate');
      if (generation !== this.generation || revision !== this.intentRevision || !this.intendedPlay || !this.connection) return;
      const alternate = { title: String(track.title || ''), author: String(track.user?.name || ''), artwork: track.artwork?.['480x480'] || track.artwork?.['150x150'] || null, url: `https://api.audius.co/v1/tracks/${encodeURIComponent(track.id)}/stream`, videoId: null, fallbackProvider: 'audius', fallbackTitle: String(track.title || ''), fallbackArtwork: track.artwork?.['480x480'] || null, fallbackOriginalTitle: query };
      const played = await this.evaluate(`(async () => {
        for (const media of document.querySelectorAll('video, audio')) { media.pause(); media.removeAttribute('autoplay'); }
        document.getElementById('movie_player')?.pauseVideo?.();
        for (const old of document.querySelectorAll('audio[data-work-audius]')) old.remove();
        const audio = document.createElement('audio');
        audio.dataset.workAudius = 'true';
        audio.src = ${JSON.stringify(alternate.url)};
        audio.volume = ${Number.isFinite(state.volume) ? Math.max(0, Math.min(1, state.volume)) : 1};
        audio.muted = ${Boolean(state.muted)};
        document.body.appendChild(audio);
        await audio.play();
        return true;
      })()`);
      if (generation === this.generation && revision === this.intentRevision && this.intendedPlay && played) { this.fallback = alternate; this.lastProgressAt = Date.now(); }
      else if (generation === this.generation && !this.intendedPlay) await this.command('pause');
    } catch (error) {
      if (generation === this.generation) this.fallbackError = `YouTube ${state.errorCode || 'unavailable'}; alternate failed: ${error.message}`;
    }
  }

  async maintainPlayback(state, now = Date.now()) {
    if (!this.intendedPlay) return;
    const generation = this.generation;
    if ([100, 101, 150].includes(state.errorCode) && !this.fallback) { await this.tryFallback(state, generation); return; }
    if (state.ended) { await this.advanceQueue(1, true); return; }
    if (Math.abs(state.currentTime - this.lastPosition) > 0.05) {
      this.lastPosition = state.currentTime;
      this.lastProgressAt = now;
    }
    const stallThreshold = state.ready && !state.playing && !state.buffering ? 2000 : 15000;
    if (now - this.lastProgressAt >= stallThreshold && now - this.lastKickAt >= 2000) {
      this.lastKickAt = now;
      await this.command('play');
    }
  }

  startPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight) return;
      this.pollInFlight = true;
      try {
        const generation = this.generation;
        const state = await this.readState();
        if (state && this.pollTimer && generation === this.generation) {
          this.lastState = state;
          this.emit('state', state);
          await this.maintainPlayback(state);
        }
      } catch (error) { this.fallbackError = error.message; }
      finally { this.pollInFlight = false; }
    }, 300);
  }

  async stop() {
    this.lifecycleGeneration++;
    this.generation++;
    this.intentRevision++;
    this.intendedPlay = false;
    this.fallback = null;
    this.lastState = null;
    this.screencasting = false;
    this.latestFrame = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    const runningProc = this.process;
    try { await this.connection?.call('Page.stopScreencast', {}, 1000); } catch {}
    try { await this.connection?.call('Browser.close', {}, 2000); } catch {}
    try { this.unsubCdpEvents?.(); } catch {}
    this.unsubCdpEvents = null;
    this.connection?.close();
    this.connection = null;
    this.targetId = null;
    this.port = null;
    this.process = null;
    if (runningProc && runningProc.exitCode === null) {
      try { runningProc.kill(); } catch {}
    }
    this.emit('status', this.status());
    return { ok: true };
  }

  // Playlist management
  async loadPlaylist() {
    try {
      const raw = await fsp.readFile(this.playlistFile, 'utf8');
      const playlist = JSON.parse(raw);
      this.queue = Array.isArray(playlist) ? playlist : [];
      return this.queue;
    } catch {
      return this.queue = [
        {
          id: 'v9EgFdRUVc4',
          title: 'YouTube Track (v9EgFdRUVc4)',
          author: 'YouTube',
          duration: '',
          thumbnail: 'https://i.ytimg.com/vi/v9EgFdRUVc4/hqdefault.jpg',
          url: 'https://www.youtube.com/watch?v=v9EgFdRUVc4',
        },
        {
          id: 'QdBZY2fkU-0',
          title: 'YouTube Track (QdBZY2fkU-0)',
          author: 'YouTube',
          duration: '',
          thumbnail: 'https://i.ytimg.com/vi/QdBZY2fkU-0/hqdefault.jpg',
          url: 'https://www.youtube.com/watch?v=QdBZY2fkU-0',
        },
        {
          id: 'kXYiU_JCYtU',
          title: 'YouTube Track (kXYiU_JCYtU)',
          author: 'YouTube',
          duration: '',
          thumbnail: 'https://i.ytimg.com/vi/kXYiU_JCYtU/hqdefault.jpg',
          url: 'https://www.youtube.com/watch?v=kXYiU_JCYtU',
        },
      ];
    }
  }

  async savePlaylist(playlist) {
    if (!Array.isArray(playlist)) return false;
    this.queue = playlist;
    try {
      await fsp.mkdir(path.dirname(this.playlistFile), { recursive: true });
      await fsp.writeFile(this.playlistFile, JSON.stringify(playlist, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  // Fast YouTube Search (No API Key)
  async fetchOembed(vid) {
    if (this.oembedCache.has(vid)) return this.oembedCache.get(vid);
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${vid}&format=json`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const info = await res.json();
      const entry = {
        id: vid,
        title: info.title || 'YouTube Video',
        author: info.author_name || 'YouTube',
        duration: '',
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${vid}`,
      };
      this.oembedCache.set(vid, entry);
      return entry;
    } catch {
      return null;
    }
  }

  async scrapeYouTubePage(targetUrl, cacheKey, extractOptions = {}) {
    const cached = this.searchCache.get(cacheKey);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
      return cached.results;
    }

    try {
      const res = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(5500),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();

      let data = null;
      const markers = ['var ytInitialData = ', 'window["ytInitialData"] = ', 'ytInitialData = '];
      for (const marker of markers) {
        const idx = html.indexOf(marker);
        if (idx === -1) continue;
        const braceIdx = html.indexOf('{', idx + marker.length);
        const jsonStr = extractBalancedJsonObject(html, braceIdx);
        if (jsonStr) {
          try {
            data = JSON.parse(jsonStr);
            break;
          } catch {}
        }
      }

      if (!data) return cached?.results || [];
      const results = extractSearchResults(data, extractOptions);

      if (results.length > 0) {
        this.searchCache.set(cacheKey, { at: Date.now(), results });
      }
      return results;
    } catch {
      return cached?.results || [];
    }
  }

  async homeFeed() {
    const home = await this.scrapeYouTubePage('https://www.youtube.com/', '__yt_home__');
    if (home.length > 0) return home;
    return this.scrapeYouTubePage('https://www.youtube.com/results?search_query=music+live+mix', '__yt_home_fallback__');
  }

  async search(query, filters = {}) {
    if (!query || typeof query !== 'string') return [];
    const clean = query.trim();
    if (!clean) return [];

    const vid = extractVideoId(clean);
    if (vid) {
      const direct = await this.fetchOembed(vid);
      if (direct) return [direct];
      return [{
        type: 'video',
        id: vid,
        title: `YouTube Track (${vid})`,
        author: 'YouTube',
        duration: '',
        thumbnail: `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${vid}`,
      }];
    }

    const type = filters?.type || 'all';
    const sp = buildSearchSp(filters);
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(clean)}${sp ? `&sp=${encodeURIComponent(sp)}` : ''}`;
    const cacheKey = `${clean.toLowerCase()}::${sp || 'all'}`;
    const results = await this.scrapeYouTubePage(url, cacheKey, {
      includeChannels: type === 'all' || type === 'channel',
      includePlaylists: type === 'all' || type === 'playlist',
    });
    const durFilter = filters?.duration || 'any';
    if (durFilter === 'any' || type === 'channel' || type === 'playlist') return results;
    return results.filter(item => {
      if (item.type && item.type !== 'video') return true;
      const secs = parseDurationSeconds(item.duration);
      if (secs === null) return false;
      if (durFilter === 'short') return secs < 240;
      if (durFilter === 'medium') return secs >= 240 && secs <= 1200;
      if (durFilter === 'long') return secs > 1200;
      return true;
    });
  }

  async browse({ kind, pathOrId, title } = {}) {
    if (kind === 'channel') {
      const cleanPath = String(pathOrId || '').trim().replace(/\/videos\/?$/, '');
      if (!/^\/(?:@[A-Za-z0-9._-]+|channel\/[A-Za-z0-9_-]+|c\/[A-Za-z0-9._-]+|user\/[A-Za-z0-9._-]+)$/.test(cleanPath)) {
        return [];
      }
      return this.scrapeYouTubePage(
        `https://www.youtube.com${cleanPath}/videos`,
        `channel::${cleanPath}`,
        { defaultAuthor: title || 'YouTube' }
      );
    }
    if (kind === 'playlist') {
      const cleanId = String(pathOrId || '').trim();
      if (!/^[A-Za-z0-9_-]{8,80}$/.test(cleanId)) return [];
      return this.scrapeYouTubePage(
        `https://www.youtube.com/playlist?list=${encodeURIComponent(cleanId)}`,
        `playlist::${cleanId}`,
        { defaultAuthor: title || 'YouTube' }
      );
    }
    return [];
  }
}
