import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = [
  readFileSync(new URL('../ui/features/shell/window-geometry.js', import.meta.url), 'utf8'),
  readFileSync(new URL('../ui/features/shell/BubbleHUD.js', import.meta.url), 'utf8'),
].join('\n');
const geometry = vm.createContext({});
vm.runInContext(`${source}\n;globalThis.geometry = { clampWorkWindow, defaultWorkWindow, presetWorkWindow, resizeWorkWindow, loadWorkWindowState, saveWorkWindowState, WORK_WINDOW_STORAGE_KEY, computeHeaderBoundingBoxes, isWorkEmbeddedActive };`, geometry);
const plain = value => JSON.parse(JSON.stringify(value));

test('BubbleHUD renders both window and bubble without shadowing React createElement', () => {
  const element = (type, props, ...children) => ({ type, props, children });
  const context = vm.createContext({
    h: element, React: { Fragment: 'fragment' },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }), useEffect: () => {},
    SvgIcon: () => null, BUBBLE_RADIAL_ICONS: { chat: '', repo: '', music: '', intel: '' },
    window: { innerWidth: 1365, innerHeight: 767, localStorage: { getItem: () => null } },
    WorkMainPanel: function WorkMainPanel() {}, InfinityLogo: function InfinityLogo() {},
  });
  vm.runInContext(source + ';globalThis.render = BubbleHUD;', context);
  const tree = context.render({ connection: {} });
  const children = tree.children.flat();
  const panel = children.find(child => child.props?.className === 'wk-global-panel');
  const bubble = children.find(child => child.props?.className === 'wk-bubble');
  assert.ok(panel);
  assert.equal(typeof panel.props.style.height, 'number');
  assert.ok(bubble);
  assert.equal(bubble.props['aria-label'], 'Open Work panel');
  bubble.props.onClick();
});

test('clamp bounds normal and constrained viewport dimensions', () => {
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 320, height: 600 }, { width: 24, height: 24 }]) {
    const frame = plain(geometry.geometry.clampWorkWindow({ x: -200, y: 9000, w: 9000, h: 9000, mode: 'custom' }, viewport));
    assert.ok(frame.x >= 0 && frame.y >= 0);
    assert.ok(frame.x + frame.w <= viewport.width);
    assert.ok(frame.y + frame.h <= viewport.height);
    assert.ok(frame.w <= Math.max(1, viewport.width));
    assert.ok(frame.h <= Math.max(1, viewport.height - 36));
  }
  const normal = plain(geometry.geometry.defaultWorkWindow({ width: 1920, height: 1080 }));
  assert.equal(normal.w, 800);
  assert.equal(normal.h, 1044);
  assert.equal(normal.mode, 'studio');
  assert.equal(normal.x, 1104);
});

test('presets use Studio-only (migrating legacy mini) and Maximized within viewport', () => {
  const viewport = { width: 1600, height: 900 };
  for (const [input, expectedMode, width, height] of [['mini', 'studio', 800, 864], ['studio', 'studio', 800, 864], ['maximized', 'maximized', 1536, 864]]) {
    const frame = plain(geometry.geometry.presetWorkWindow(input, {}, viewport));
    assert.equal(frame.mode, expectedMode);
    assert.equal(frame.w, width);
    assert.equal(frame.h, height);
    assert.ok(frame.x >= 0 && frame.y >= 0);
    assert.ok(frame.x + frame.w <= viewport.width);
    assert.ok(frame.y + frame.h <= viewport.height);
  }
  const maximized = plain(geometry.geometry.presetWorkWindow('maximized', {}, viewport));
  assert.equal(maximized.x, 64);
  assert.equal(maximized.y, 36);
  assert.equal(maximized.w, 1536);
  assert.equal(maximized.h, 864);
  const small = plain(geometry.geometry.presetWorkWindow('studio', {}, { width: 320, height: 420 }));
  assert.ok(small.w <= 320 && small.h <= 384);
});

test('resize edges clamp dimensions and preserve the opposite anchor', () => {
  const viewport = { width: 1200, height: 900 };
  const initial = { x: 300, y: 200, w: 560, h: 600, mode: 'studio' };
  const west = plain(geometry.geometry.resizeWorkWindow(initial, 'w', 80, 0, viewport));
  assert.equal(west.w, 480);
  assert.equal(west.x + west.w, initial.x + initial.w);
  const north = plain(geometry.geometry.resizeWorkWindow(initial, 'n', 0, -80, viewport));
  assert.equal(north.h, 680);
  assert.equal(north.y + north.h, initial.y + initial.h);
  const minimum = plain(geometry.geometry.resizeWorkWindow(initial, 'nw', 1000, 1000, viewport));
  assert.equal(minimum.w, 380);
  assert.equal(minimum.h, 480);
  assert.equal(minimum.mode, 'custom');
});

test('window state persistence validates, clamps, and tolerates storage failure', () => {
  const store = { value: null, getItem(key) { assert.equal(key, 'dsh_work_window_state'); return this.value; }, setItem(key, value) { assert.equal(key, 'dsh_work_window_state'); this.value = value; } };
  const defaultFrame = plain(geometry.geometry.loadWorkWindowState({ width: 1920, height: 1080 }, store));
  assert.equal(defaultFrame.mode, 'studio');
  const saved = { x: 2000, y: -20, w: 700, h: 700, mode: 'studio' };
  geometry.geometry.saveWorkWindowState(saved, store);
  assert.deepEqual(JSON.parse(store.value), saved);
  assert.equal(plain(geometry.geometry.loadWorkWindowState({ width: 900, height: 700 }, store)).x, 200);
  store.value = '{bad json';
  assert.equal(plain(geometry.geometry.loadWorkWindowState({ width: 1920, height: 1080 }, store)).mode, 'studio');
  assert.doesNotThrow(() => geometry.geometry.saveWorkWindowState(saved, { setItem() { throw new Error('blocked'); } }));
});

test('useResizableWindow coalesces pointer updates, persists state, and cleans up', () => {
  const listeners = new Map();
  const frames = new Map();
  const writes = [];
  let nextFrame = 0;
  const window = {
    innerWidth: 1600,
    innerHeight: 1000,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
  };
  const localStorage = { value: null, getItem() { return this.value; }, setItem(key, value) { writes.push(key); this.value = value; } };
  const state = [];
  const refs = [];
  let stateIndex = 0;
  let refIndex = 0;
  let effectCleanup;
  const React = {
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
    },
    useRef(initial) {
      const index = refIndex++;
      if (!(index in refs)) refs[index] = { current: initial };
      return refs[index];
    },
    useEffect(effect) { if (!effectCleanup) effectCleanup = effect(); },
  };
  const workSurface = { open: false, set(value) { this.open = value; } };
  const context = vm.createContext({ React, window, localStorage, workSurface, useState: React.useState, useRef: React.useRef, useEffect: React.useEffect });
  vm.runInContext(`${source}\n;globalThis.mountHook = useResizableWindow;`, context);
  const render = () => { stateIndex = 0; refIndex = 0; return context.mountHook(); };
  let hook = render();
  const capture = { released: 0, setPointerCapture() {}, hasPointerCapture() { return true; }, releasePointerCapture() { this.released += 1; } };
  hook.beginPointer('move', { button: 0, pointerId: 7, clientX: 100, clientY: 120, preventDefault() {}, currentTarget: capture });
  hook.movePointer({ pointerId: 7, clientX: 60, clientY: 170 });
  hook.movePointer({ pointerId: 7, clientX: 50, clientY: 180 });
  assert.equal(frames.size, 1, 'multiple pointer moves share one animation frame');
  const [frameId, callback] = frames.entries().next().value;
  frames.delete(frameId);
  callback();
  hook = render();
  assert.equal(hook.frame.x, 734);
  assert.equal(hook.frame.y, 36);
  assert.deepEqual(writes, ['dsh_work_window_state']);
  hook.endPointer({ pointerId: 7 });
  assert.equal(capture.released, 1);

  listeners.get('keydown')({ altKey: true, ctrlKey: false, metaKey: false, key: 'w', preventDefault() {} });
  assert.equal(vm.runInContext('workSurface.open', context), true);
  listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(vm.runInContext('workSurface.open', context), false);
  // Disabling Bubble also blocks Alt+W from popping open the overlay
  vm.runInContext('workSurface.bubbleEnabled = false;', context);
  listeners.get('keydown')({ altKey: true, ctrlKey: false, metaKey: false, key: 'w', preventDefault() {} });
  assert.equal(vm.runInContext('workSurface.open', context), false);
  effectCleanup();
  assert.equal(listeners.size, 0);
  assert.equal(frames.size, 0);
});

test('WorkEntry mounts embedded without auto-opening the floating Bubble overlay', () => {
  const React = { useEffect(effect) { effect(); } };
  const workSurface = { open: true, set(value) { this.open = value; } };
  const context = vm.createContext({ React, workSurface, useEffect: React.useEffect, WorkMainPanel: () => null, h: () => null });
  vm.runInContext(`${source}\n;globalThis.entries = { WorkEntry };`, context);
  assert.doesNotMatch(source, /function WorkLauncher/);
  context.entries.WorkEntry();
  assert.equal(vm.runInContext('workSurface.open', context), false);
});

test('header is ultra-slim with only title, vector maximize icon, and close button (zero collision at 380px)', () => {
  const element = (type, props, ...children) => ({ type, props, children: children.flat() });
  const context = vm.createContext({
    h: element, React: { Fragment: 'fragment' },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }), useEffect: () => {},
    SvgIcon: props => ({ type: 'svg', props }), BUBBLE_RADIAL_ICONS: { chat: '', repo: '', music: '', intel: '' },
    window: { innerWidth: 1024, innerHeight: 768, localStorage: { getItem: () => null } },
    WorkMainPanel: function WorkMainPanel() {}, InfinityLogo: function InfinityLogo() {},
  });
  vm.runInContext(source + ';globalThis.render = BubbleHUD;', context);
  const tree = context.render({ connection: {} });
  const children = tree.children.flat();
  const panel = children.find(child => child.props?.className === 'wk-global-panel');
  assert.ok(panel);
  const header = panel.children.find(child => child.key === 'header' || child.type === 'header');
  assert.ok(header);

  const left = header.children.find(c => c?.props?.key === 'header-left' || c?.props?.className === 'wk-header-left');
  const right = header.children.find(c => c?.props?.key === 'header-right' || c?.props?.className === 'wk-header-right');
  assert.ok(left, 'header must include left group with title');
  assert.ok(right, 'header must include right group with window controls');

  assert.equal(left.children.find(c => c?.props?.key === 'back'), undefined, 'back button must be removed');
  const titleEl = left.children.find(c => c?.props?.key === 'title' || c?.props?.className === 'wk-header-title');
  assert.ok(titleEl);
  assert.equal(titleEl.props.style.maxWidth, 140);

  assert.equal(right.children.find(c => c?.props?.key === 'preset'), undefined, 'preset/studio select must be removed');
  assert.equal(right.children.find(c => c?.props?.className === 'wk-header-git'), undefined, 'No branch git chrome must be removed');

  const maxEl = right.children.find(c => c?.props?.key === 'maximize');
  assert.ok(maxEl);
  assert.equal(maxEl.props.style.width, 26);
  assert.equal(maxEl.children[0]?.type, context.SvgIcon, 'Maximize must render an SVG vector icon');

  const closeEl = right.children.find(c => c?.props?.key === 'close');
  assert.ok(closeEl);

  const boxes = geometry.geometry.computeHeaderBoundingBoxes(380);
  assert.ok(boxes.title.right < boxes.controls.left, `rect(title).right (${boxes.title.right}) must be < rect(controls).left (${boxes.controls.left})`);
  assert.ok(boxes.maxBtn.right < boxes.close.left);
  assert.ok(boxes.close.right <= 380 - 10);
});

test('zero unhandled exceptions on window drag and maximize toggle', () => {
  const context = vm.createContext({
    React: {
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
      useRef: current => ({ current }),
      useEffect: () => {},
    },
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: current => ({ current }),
    useEffect: () => {},
    window: {
      innerWidth: 1200,
      innerHeight: 800,
      requestAnimationFrame: fn => fn(),
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      localStorage: { getItem: () => null, setItem: () => {} }
    }
  });
  vm.runInContext(source + ';globalThis.hook = useResizableWindow();', context);
  const hook = context.hook;
  assert.doesNotThrow(() => {
    hook.toggleMaximize();
    hook.toggleMaximize();
    const capture = { setPointerCapture() {}, hasPointerCapture: () => true, releasePointerCapture() {} };
    hook.beginPointer('move', { button: 0, pointerId: 1, clientX: 200, clientY: 200, preventDefault() {}, currentTarget: capture });
    hook.movePointer({ pointerId: 1, clientX: 250, clientY: 250 });
    hook.endPointer({ pointerId: 1 });
  });
});
