const BUBBLE_SIZE = 43;
const RADIAL_SIZE = 24;
const RADIAL_CENTER_OFFSET = Math.round((BUBBLE_SIZE - RADIAL_SIZE) / 2);

function clampBubble(x, y, width, height, size = BUBBLE_SIZE) {
  return {
    x: Math.max(8, Math.min(Number.isFinite(x) ? x : 8, Math.max(8, width - size - 8))),
    y: Math.max(8, Math.min(Number.isFinite(y) ? y : 8, Math.max(8, height - size - 8))),
  };
}

const TOP_CLEARANCE = 36;
const SIDEBAR_WIDTH = 64;
const WORK_WINDOW_STORAGE_KEY = 'dsh_work_window_state';
const WORK_BUBBLE_STORAGE_KEY = 'dsh_work_bubble_enabled';
const WORK_WINDOW_MODES = new Set(['studio', 'maximized', 'custom']);

let isEmbeddedActive = false;
if (typeof globalThis !== 'undefined') {
  globalThis.isEmbeddedActive = false;
}

function readBubbleEnabledPreference(storage) {
  try {
    const raw = (storage || globalThis.localStorage)?.getItem(WORK_BUBBLE_STORAGE_KEY);
    if (raw === 'false' || raw === '0') return false;
    if (raw === 'true' || raw === '1') return true;
  } catch {}
  return true;
}

function writeBubbleEnabledPreference(enabled, storage) {
  try {
    (storage || globalThis.localStorage)?.setItem(WORK_BUBBLE_STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {}
}

function computeHeaderBoundingBoxes(width = 380) {
  const padLeft = 10;
  const padRight = 10;
  const gap = 6;
  const titleMaxWidth = 140;
  const maxBtnWidth = 26;
  const closeWidth = 26;

  const titleLeft = padLeft;
  const titleRight = titleLeft + titleMaxWidth;

  const rightControlsWidth = maxBtnWidth + gap + closeWidth;
  const controlsLeft = width - padRight - rightControlsWidth;

  const maxBtnLeft = controlsLeft;
  const maxBtnRight = maxBtnLeft + maxBtnWidth;
  const closeLeft = maxBtnRight + gap;
  const closeRight = closeLeft + closeWidth;

  return {
    title: { left: titleLeft, right: titleRight },
    controls: { left: controlsLeft, right: width - padRight },
    maxBtn: { left: maxBtnLeft, right: maxBtnRight },
    close: { left: closeLeft, right: closeRight },
  };
}

function viewportSize(viewport = {}) {
  return {
    width: Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1024,
    height: Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 768,
  };
}

function windowLimits(viewport = {}) {
  const { width, height } = viewportSize(viewport);
  const topClearance = Math.min(TOP_CLEARANCE, Math.max(0, height - 1));
  const maxWidth = Math.max(1, width);
  const maxHeight = Math.max(1, height - topClearance);
  return {
    width,
    height,
    minWidth: Math.min(380, maxWidth),
    minHeight: Math.min(480, maxHeight),
    maxWidth,
    maxHeight,
    topClearance,
  };
}

function clampWorkWindow(frame = {}, viewport = {}) {
  const limits = windowLimits(viewport);
  const clamp = (value, fallback, min, max) => Math.max(min, Math.min(Number.isFinite(value) ? value : fallback, max));
  const mode = WORK_WINDOW_MODES.has(frame.mode) ? frame.mode : 'custom';
  if (mode === 'maximized') {
    const w = Math.max(1, limits.width - SIDEBAR_WIDTH);
    return {
      x: limits.width > SIDEBAR_WIDTH ? SIDEBAR_WIDTH : 0,
      y: limits.topClearance,
      w,
      h: limits.maxHeight,
      mode: 'maximized',
    };
  }
  const w = clamp(frame.w, 560, limits.minWidth, limits.maxWidth);
  const h = clamp(frame.h, 760, limits.minHeight, limits.maxHeight);
  const minX = 0;
  const maxX = Math.max(0, limits.width - w);
  const minY = limits.topClearance;
  const maxY = Math.max(minY, limits.height - h);
  return {
    x: clamp(frame.x, maxX, minX, maxX),
    y: clamp(frame.y, minY, minY, maxY),
    w,
    h,
    mode,
  };
}

function defaultWorkWindow(viewport = {}) {
  return presetWorkWindow('studio', {}, viewport);
}

function presetWorkWindow(mode, current = {}, viewport = {}) {
  const limits = windowLimits(viewport);
  let w;
  let h;
  let x;
  let y;
  const top = limits.topClearance;
  const fullH = limits.maxHeight;
  const normalizedMode = mode === 'mini' ? 'studio' : mode;
  if (normalizedMode === 'studio') {
    w = 800;
    h = fullH;
    x = limits.width - Math.min(w, limits.maxWidth) - 16;
    y = top;
  } else if (normalizedMode === 'maximized') {
    w = Math.max(1, limits.width - SIDEBAR_WIDTH);
    h = fullH;
    x = limits.width > SIDEBAR_WIDTH ? SIDEBAR_WIDTH : 0;
    y = top;
  } else {
    return clampWorkWindow(current, viewport);
  }
  return clampWorkWindow({ x, y, w, h, mode: normalizedMode }, viewport);
}

function resizeWorkWindow(start, edge, dx, dy, viewport = {}) {
  const original = clampWorkWindow(start, viewport);
  let { x, y, w, h } = original;
  const limits = windowLimits(viewport);
  if (edge.includes('e')) w += dx;
  if (edge.includes('s')) h += dy;
  if (edge.includes('w')) { w -= dx; x += dx; }
  if (edge.includes('n')) { h -= dy; y += dy; }
  w = Math.max(limits.minWidth, Math.min(w, limits.maxWidth));
  h = Math.max(limits.minHeight, Math.min(h, limits.maxHeight));
  if (edge.includes('w')) {
    const maxWFromAnchor = Math.max(limits.minWidth, original.x + original.w);
    w = Math.min(w, maxWFromAnchor);
    x = original.x + original.w - w;
  }
  if (edge.includes('n')) {
    const maxHFromAnchor = Math.max(limits.minHeight, original.y + original.h - limits.topClearance);
    h = Math.min(h, maxHFromAnchor);
    y = original.y + original.h - h;
  }
  return clampWorkWindow({ ...original, x, y, w, h, mode: 'custom' }, viewport);
}

function loadWorkWindowState(viewport = {}, storage) {
  const fallback = defaultWorkWindow(viewport);
  try {
    const saved = JSON.parse((storage || globalThis.localStorage)?.getItem(WORK_WINDOW_STORAGE_KEY) || 'null');
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y) || !Number.isFinite(saved.w) || !Number.isFinite(saved.h)) return fallback;
    if (saved.mode === 'mini') return fallback;
    return clampWorkWindow({ ...saved, mode: WORK_WINDOW_MODES.has(saved.mode) ? saved.mode : 'studio' }, viewport);
  } catch {
    return fallback;
  }
}

function saveWorkWindowState(frame, storage) {
  try {
    (storage || globalThis.localStorage)?.setItem(WORK_WINDOW_STORAGE_KEY, JSON.stringify(frame));
  } catch {}
}

function computeRadialOffsets(point = {}, viewport = {}) {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1024;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 768;
  const px = Number.isFinite(point.x) ? point.x : width - (BUBBLE_SIZE + 12);
  const py = Number.isFinite(point.y) ? point.y : height - (BUBBLE_SIZE + 28);
  const isRightHalf = px > width / 2;
  const nearBottom = py > height - 130;
  const nearTop = py < 110;
  // Keep 24px radial hover buttons at full size around the 90% (43px) bubble.
  const radius = 51;
  // Angles in degrees measured clockwise from +X (0° = right, 90° = down, -90° = up, 180° = left)
  const angles = nearBottom
    ? (isRightHalf ? [-92, -127, -162, -197] : [-88, -53, -18, 17])
    : nearTop
      ? (isRightHalf ? [188, 153, 118, 83] : [-8, 27, 62, 97])
      : (isRightHalf ? [-110, -145, -180, -215] : [-70, -35, 0, 35]);
  const items = [
    { key: 'chats', tab: 'messages', title: 'Chats', iconKey: 'chat' },
    { key: 'repo', tab: 'mesh', title: 'Repo', iconKey: 'repo' },
    { key: 'music', tab: 'music', title: 'Music', iconKey: 'music' },
    { key: 'intel', tab: 'intel', title: 'Intel', iconKey: 'intel' },
  ];
  const minLeft = 8;
  const maxLeft = Math.max(minLeft, width - (RADIAL_SIZE + 8));
  const minTop = Math.min(TOP_CLEARANCE + 4, height - (RADIAL_SIZE + 8));
  const maxTop = Math.max(minTop, height - (RADIAL_SIZE + 8));
  return items.map((item, idx) => {
    const rad = (angles[idx] * Math.PI) / 180;
    const rawDx = Math.round(Math.cos(rad) * radius);
    const rawDy = Math.round(Math.sin(rad) * radius);
    const clampedLeft = Math.max(minLeft, Math.min(px + RADIAL_CENTER_OFFSET + rawDx, maxLeft));
    const clampedTop = Math.max(minTop, Math.min(py + RADIAL_CENTER_OFFSET + rawDy, maxTop));
    return {
      ...item,
      dx: clampedLeft - (px + RADIAL_CENTER_OFFSET),
      dy: clampedTop - (py + RADIAL_CENTER_OFFSET),
    };
  });
}

const workSurface = {
  open: false,
  embedded: false,
  bubbleEnabled: readBubbleEnabledPreference(),
  activeTab: null,
  updateAvailable: null,
  listeners: new Set(),
  tabListeners: new Set(),
  stateListeners: new Set(),
  bubbleListeners: new Set(),
  sharedState: {
    workTab: 'messages',
    managementOpen: false,
    activePeer: { peerToken: 'channel:general', alias: 'general', isChannel: true },
    showConversation: false,
    conversationFilter: 'chats',
    workspaceDir: '',
    audioPopoverOpen: false,
    isHost: false,
    publishingUpdate: false,
    onPublishUpdate: null,
    showBubble: readBubbleEnabledPreference(),
    channels: null,
    notesList: null,
    peerList: null,
  },
  getState() {
    return this.sharedState;
  },
  updateState(patch) {
    if (!patch || typeof patch !== 'object') return;
    const next = { ...this.sharedState, ...patch };
    const changed = Object.keys(patch).some(k => this.sharedState[k] !== next[k]);
    if (!changed) return;
    this.sharedState = next;
    this.stateListeners.forEach(fn => fn(this.sharedState));
  },
  subscribeState(fn) {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  },
  setBubbleEnabled(enabled, persist = true) {
    const next = enabled !== false;
    this.bubbleEnabled = next;
    if (persist) writeBubbleEnabledPreference(next);
    this.updateState({ showBubble: next });
    if (!next && this.open) this.set(false);
    this.bubbleListeners.forEach(fn => fn(next));
  },
  subscribeBubble(fn) {
    this.bubbleListeners.add(fn);
    return () => this.bubbleListeners.delete(fn);
  },
  get isEmbeddedActive() {
    return isWorkEmbeddedActive();
  },
  set isEmbeddedActive(val) {
    isEmbeddedActive = Boolean(val);
    if (typeof globalThis !== 'undefined') globalThis.isEmbeddedActive = isEmbeddedActive;
    this.embedded = isEmbeddedActive;
  },
  set(open) {
    this.open = Boolean(open);
    this.listeners.forEach(fn => fn(this.open));
  },
  setTab(tab) {
    this.activeTab = tab;
    if (tab === 'settings') {
      this.updateState({ managementOpen: true, showConversation: true, audioPopoverOpen: false });
    } else if (tab) {
      this.updateState({
        workTab: tab,
        managementOpen: false,
        audioPopoverOpen: tab === 'music',
        showConversation: tab !== 'messages' ? true : this.sharedState.showConversation,
      });
    } else {
      this.updateState({ workTab: 'messages', managementOpen: false, showConversation: false, audioPopoverOpen: false });
    }
    this.tabListeners.forEach(fn => fn(tab));
  },
  setUpdate(info) {
    this.updateAvailable = info;
    this.listeners.forEach(fn => fn(this.open));
  },
};

function isWorkEmbeddedActive() {
  if (isEmbeddedActive || workSurface.embedded || (typeof globalThis !== 'undefined' && Boolean(globalThis.isEmbeddedActive))) return true;
  if (typeof document !== 'undefined') {
    const mainEl = document.querySelector('.wk-app:not(.wk-global-panel .wk-app), .wk-app.wk-embedded');
    if (mainEl) return true;
  }
  return false;
}

function focusEmbeddedWorkspace() {
  if (typeof document !== 'undefined') {
    const mainEl = document.querySelector('.wk-app:not(.wk-global-panel .wk-app), .wk-app.wk-embedded');
    mainEl?.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    if (mainEl && typeof mainEl.focus === 'function') mainEl.focus();
  }
}

function WorkEntry(props) {
  useEffect(() => {
    isEmbeddedActive = true;
    workSurface.embedded = true;
    workSurface.isEmbeddedActive = true;
    if (typeof globalThis !== 'undefined') globalThis.isEmbeddedActive = true;
    // Keep floating Bubble overlay collapsed so leaving Sidebar never pops it up unexpectedly.
    workSurface.set(false);
    return () => {
      isEmbeddedActive = false;
      workSurface.embedded = false;
      workSurface.isEmbeddedActive = false;
      if (typeof globalThis !== 'undefined') globalThis.isEmbeddedActive = false;
    };
  }, []);
  const connection = props?.connection || (typeof activeConnection !== 'undefined' ? activeConnection : null);
  return h(WorkMainPanel, { ...(props || {}), connection, isEmbedded: true });
}
