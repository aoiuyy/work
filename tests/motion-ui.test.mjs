import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { UI_SCRIPTS, UI_STYLES } from '../scripts/build-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = name => readFileSync(path.join(root, name), 'utf8');
const template = source('ui/client.template.js');
const styles = UI_STYLES.map(source).join('\n');
const scripts = UI_SCRIPTS.map(source).join('\n');

function runtime() {
  let state = [], index = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: initial => { const key = index++; if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial; return [state[key], value => { state[key] = typeof value === 'function' ? value(state[key]) : value; }]; },
    useEffect: () => {}, useRef: value => ({ current: value }), useCallback: fn => fn, useMemo: fn => fn(),
  };
  const code = template
    .replace('/* WORK_STYLES */', styles)
    .replace('/* WORK_COMPONENTS */', scripts)
    .replace(/    return \{\s+inject:/, '    globalThis.studio = { WorkMainPanel, ItunesPlayer, droppedRepositoryPath };\n    return {\n      inject:');
  const context = { URL, setTimeout: () => {}, window: { __ModuleLoader__: { load: module => module.factory(() => React) } } };
  vm.runInNewContext(code, context);
  return { ...context.studio, render: fn => { index = 0; return fn(); } };
}
const nodes = tree => [tree, ...(tree?.children || []).flatMap(nodes)];
const find = (tree, label) => nodes(tree).find(n => n.props?.['aria-label'] === label || n.children?.includes(label));
test('native drops accept only absolute local filesystem paths', () => {
  const { droppedRepositoryPath: path } = runtime();
  const data = uri => ({ getData: type => type === 'text/uri-list' ? uri : '' });
  assert.equal(path({ files: [{ path: 'D:\\code\\project' }] }), 'D:\\code\\project');
  assert.equal(path(data('file:///D:/code/my%20repo')), 'D:/code/my repo');
  assert.equal(path(data('# comment\nfile:///tmp/repo')), '/tmp/repo');
  for (const uri of ['https://example.com/repo', 'file://remote/share/repo', 'relative/repo', 'file:///tmp/repo%00']) assert.equal(path(data(uri)), null);
  assert.equal(path({ files: [{ name: 'folder' }] }), null);
});
test('settings lives outside conversation rail and repository tools only appear in Git Mesh', () => {
  const app = runtime();
  const connection = { rpc: { call: async () => ({ ok: false }) } };
  const render = () => app.render(() => app.WorkMainPanel({ connection }));
  let tree = render();
  assert.equal(find(tree, 'Select local repository'), undefined);
  find(tree, 'Open settings').props.onClick(); tree = render();
  const settingsNode = nodes(tree).find(n => typeof n.type === 'function' && n.type.name === 'SettingsPanel');
  assert.ok(settingsNode);
  let settings = settingsNode.type(settingsNode.props);
  assert.equal(settings.props['aria-label'], 'Work settings');
  assert.equal(nodes(nodes(tree).find(n => n.type === 'aside')).includes(settingsNode), false);
  assert.ok(find(settings, 'Account'));
  assert.ok(find(settings, 'Workspace'));
  assert.equal(find(settings, 'Network & Collaborators'), undefined);
  find(settings, 'Close settings').props.onClick(); tree = render();
  find(tree, 'Git Mesh').props.onClick(); tree = render();
  assert.ok(find(tree, 'Open local repository').props.onDrop);
  assert.ok(find(tree, 'Open local repository').props.onDragOver);
});
test('browser drops show recovery and backend validates before selecting repository', async () => {
  const app = runtime(); const calls = [];
  const connection = { rpc: { call: async (_, action, payload) => { calls.push([action, payload]); return { ok: true, value: { isGit: false } }; } } };
  const render = () => app.render(() => app.WorkMainPanel({ connection }));
  let tree = render(); find(tree, 'Git Mesh').props.onClick(); tree = render();
  const drop = dataTransfer => find(tree, 'Open local repository').props.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer });
  await drop({ files: [{ name: 'folder' }] }); tree = render();
  assert.ok(nodes(tree).some(n => n.type === 'p' && n.children.some(c => typeof c === 'string' && c.includes('native folder picker'))));
  assert.equal(calls.length, 0);
  await drop({ files: [{ path: 'D:\\repo' }] }); tree = render();
  assert.equal(calls[0][0], 'work/getGitStatus');
  assert.equal(calls[0][1].args.repoPath, 'D:\\repo');
  assert.ok(find(tree, 'Open local repository'));
});
test('one keyed player persists while Music hides only its capsule', () => {
  const app = runtime(); const render = () => app.render(() => app.WorkMainPanel({ connection: {} }));
  let tree = render(); find(tree, 'Music').props.onClick(); tree = render();
  const players = nodes(tree).filter(n => n.type === app.ItunesPlayer);
  assert.equal(players.length, 1); assert.equal(players[0].props.key, 'persistent-player'); assert.equal(players[0].props.musicActive, true);
  const playerApp = runtime();
  const player = playerApp.render(() => playerApp.ItunesPlayer({ connection: {}, musicActive: true, popoverOpen: true, setPopoverOpen() {} }));
  assert.equal(nodes(player).some(n => n.props?.className === 'wk-mini-audio-strip'), false);
  assert.ok(find(player, 'Music controls')); assert.ok(find(player, 'Player volume')); assert.ok(find(player, 'Seek in full player'));
});
test('neutral tokens stay scoped and capsule reveal never changes geometry', () => {
  assert.match(styles, /\.wk-global-panel,\.wk-bubble \{\s+--wk-canvas: #0c0e12/);
  for (const color of ['#12151b', '#181c24', '#202531', '#e6edf3', '#8b949e', '#545d68']) assert.ok(styles.includes(color));
  assert.doesNotMatch(styles, /:root\s*\{/);
  assert.match(styles, /\.wk-player-footer \{[^}]*width: 320px;[^}]*max-width: calc\(100% - 24px\); height: 38px/);
  assert.match(styles, /\.wk-capsule-controls \{ position: absolute/);
  assert.match(styles, /:focus-within \.wk-capsule-controls/);
  assert.match(styles, /prefers-reduced-motion: reduce\) \{ \.wk-bubble \{ transition: none !important/);
  assert.doesNotMatch(styles, /transition:\s*all/);
});
