import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const code = readFileSync(new URL('../ui/features/music/ItunesPlayer.js', import.meta.url), 'utf8');
const mainPanel = readFileSync(new URL('../ui/features/shell/WorkMainPanel.js', import.meta.url), 'utf8');
test('one structural player mount retains hooks and searches across tab changes', () => {
  assert.equal((mainPanel.match(/h\(ItunesPlayer,/g) || []).length, 1);
  assert.ok(mainPanel.includes("musicActive: workTab === 'music'"));
  assert.ok(mainPanel.includes("key: 'persistent-player'"));
});
function runtime() {
  const state = []; let index = 0; const calls = [];
  const context = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: value => { const key = index++; if (!(key in state)) state[key] = value; return [state[key], value => { state[key] = typeof value === 'function' ? value(state[key]) : value; }]; },
    useRef: value => ({ current: value }), useEffect: () => {}, useCallback: fn => fn,
    SvgIcon: 'svg', Icons: new Proxy({}, { get: (_, key) => key }), formatTime: value => String(value), performance: { now: () => 1000 },
    callWorkRpc: async (_, action, args) => { calls.push({ action, args }); return { ok: true, value: { saved: true } }; },
  });
  vm.runInContext(code, context);
  return { state, calls, render(props = {}) { index = 0; context.props = { connection: {}, popoverOpen: true, setPopoverOpen() {}, ...props }; return vm.runInContext('ItunesPlayer(props)', context); } };
}
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(nodes)];
test('mini footer exposes hover volume popover, mute toggle and transport without seek bar', () => {
  const app = runtime(); const tree = app.render({ popoverOpen: false });
  const labels = nodes(tree).map(node => node.props['aria-label']);
  for (const label of ['Mini player volume', 'Mute', 'Previous track', 'Play', 'Next track']) assert.ok(labels.includes(label), label);
  assert.equal(labels.includes('Seek in mini player'), false);
  assert.equal(nodes(tree).some(node => node.props.className === 'wk-mini-vol-popover'), true);
  assert.equal(nodes(tree).some(node => node.props.className === 'wk-audio-popover wk-player-expanded'), false);
});
test('Music surface combines artwork, transport and discovery without a duplicate media player', () => {
  const app = runtime(); const tree = app.render({ musicActive: true }); const all = nodes(tree);
  for (const label of ['Now playing artwork', 'Seek in full player', 'Search music or paste YouTube URL', 'Repeat off']) assert.ok(all.some(node => node.props['aria-label'] === label), label);
  assert.equal(all.filter(node => ['audio', 'video', 'iframe'].includes(node.type)).length, 0);
  assert.ok(all.some(node => node.children.includes('You have to lock in')));
});
test('repeat cycles distinct off, one, all states and sends mode contract', async () => {
  const app = runtime();
  for (const label of ['Repeat off', 'Repeat one', 'Repeat all']) {
    const tree = app.render({ musicActive: true });
    await nodes(tree).find(node => node.props['aria-label'] === label).props.onClick();
  }
  assert.deepEqual(app.calls.map(call => call.args.mode), ['one', 'all', 'off']);
  assert.deepEqual(app.calls.map(call => call.args.value), [true, false, false]);
});
test('play control updates immediately and sends explicit play instead of ambiguous toggle', async () => {
  const app = runtime(); const tree = app.render({ musicActive: true });
  await nodes(tree).find(node => node.props['aria-label'] === 'Play').props.onClick();
  assert.equal(app.calls[0].args.command, 'play');
  assert.ok(nodes(app.render({ musicActive: true })).some(node => node.props['aria-label'] === 'Pause'));
});

test('search result cards show compact views/time without right play button, and expose YouTube filters', async () => {
  const listeners = {};
  const state = []; let index = 0; const calls = [];
  const context = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: value => { const key = index++; if (!(key in state)) state[key] = value; return [state[key], v => { state[key] = typeof v === 'function' ? v(state[key]) : v; }]; },
    useRef: value => ({ current: value }),
    useEffect: (fn, deps) => { if (deps && deps.length === 0) fn(); },
    useCallback: fn => fn,
    SvgIcon: 'svg',
    Icons: new Proxy({}, { get: (_, key) => key }),
    formatTime: value => String(value),
    performance: { now: () => 1000 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
    window: {
      addEventListener: (ev, fn) => { listeners[ev] = fn; },
      removeEventListener: () => {},
    },
    callWorkRpc: async (_, action, args) => {
      calls.push({ action, args });
      if (action === 'musicSearch') {
        return {
          ok: true,
          value: [
            { type: 'video', id: 'abcdefghijk', title: 'Test Video', author: 'Test Chan', views: '3.7M', published: '3mo ago', duration: '3:19', thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=abcdefghijk' },
            { type: 'channel', id: 'UC123', title: 'Lofi Girl', handle: '@LofiGirl', subscribers: '15.8M', channelPath: '/@LofiGirl', thumbnail: 'https://yt3.ggpht.com/a.jpg' },
          ],
        };
      }
      return { ok: true, value: { saved: true } };
    },
  });
  vm.runInContext(code, context);
  const render = (props = {}) => { index = 0; context.props = { connection: {}, popoverOpen: true, setPopoverOpen() {}, musicActive: true, ...props }; return vm.runInContext('ItunesPlayer(props)', context); };

  let tree = render();
  const input = nodes(tree).find(n => n.props['aria-label'] === 'Search music or paste YouTube URL');
  input.props.onChange({ target: { value: 'lofi' } });
  tree = render();
  const searchBtn = nodes(tree).find(n => n.props['aria-label'] === 'Search music');
  await searchBtn.props.onClick();
  tree = render();

  const all = nodes(tree);
  assert.ok(all.some(n => n.children.includes('3.7M')));
  assert.ok(all.some(n => n.children.includes('3mo ago')));
  assert.equal(all.some(n => n.props['aria-label'] === 'Play Test Video'), false);
  assert.ok(all.some(n => n.props['aria-label'] === 'Add Test Video to queue'));
  for (const label of ['All', 'Videos', 'Channels', 'Playlists', 'Filters']) {
    assert.ok(all.some(n => n.children.includes(label)), label);
  }

  // Keyboard shortcuts: active when musicActive, ignored when typing in input or when musicActive=false
  let prevented = 0;
  listeners.keydown({ key: ' ', code: 'Space', target: { tagName: 'DIV' }, preventDefault() { prevented++; } });
  assert.equal(prevented, 1);
  assert.ok(calls.some(c => c.action === 'musicCommand' && c.args.command === 'play'));

  prevented = 0;
  listeners.keydown({ key: ' ', code: 'Space', target: { tagName: 'INPUT', type: 'text' }, preventDefault() { prevented++; } });
  assert.equal(prevented, 0);

  render({ musicActive: false });
  prevented = 0;
  listeners.keydown({ key: ' ', code: 'Space', target: { tagName: 'DIV' }, preventDefault() { prevented++; } });
  assert.equal(prevented, 0);
});
