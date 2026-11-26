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
const player = source('ui/features/music/ItunesPlayer.js');

function runtime() {
  let plugin, state = [], index = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: initial => { const key = index++; if (!(key in state)) state[key] = typeof initial === 'function' ? initial() : initial; return [state[key], value => { state[key] = typeof value === 'function' ? value(state[key]) : value; }]; },
    useEffect: () => {}, useRef: value => ({ current: value }), useCallback: fn => fn, useMemo: fn => fn(),
  };
  const code = template
    .replace('/* WORK_STYLES */', styles)
    .replace('/* WORK_COMPONENTS */', scripts)
    .replace(/    return \{\s+inject:/, "    globalThis.studio = { WorkMainPanel, ItunesPlayer, renderMessageMarkdown };\n    return {\n      inject:");
  const context = { window: { __ModuleLoader__: { load: module => { plugin = module.factory(() => React); } } } };
  vm.runInNewContext(code, context);
  return { plugin, studio: context.studio, render: fn => { index = 0; return fn(); } };
}
function nodes(tree) { return [tree, ...(tree?.children || []).flatMap(nodes)]; }

test('technical message markdown remains escaped React text', () => {
  const app = runtime();
  const rendered = app.studio.renderMessageMarkdown('**bold** and `inline`\n```js\n<script>alert(1)</script>\n```');
  const all = rendered.flatMap(nodes);
  assert.ok(all.some(n => n.type === 'strong' && n.children.includes('bold')));
  assert.ok(all.some(n => n.type === 'code' && n.children.includes('inline')));
  assert.ok(all.some(n => n.type === 'pre'));
  assert.ok(all.some(n => n.type === 'code' && n.children.some(c => typeof c === 'string' && c.includes('<script>'))));
  assert.ok(all.every(n => !n.props?.dangerouslySetInnerHTML));
});
test('Studio module registers WorkEntry directly and preserves RPC transport', () => {
  const { plugin } = runtime(); const registrations = [];
  plugin.apply({ get: () => ({}), slots: { inject: (_, fn) => fn(), register: (options, factory) => registrations.push({ options, factory }) } });
  assert.equal(registrations.find(r => r.options.name === 'main').factory().type.name, 'WorkEntry');
  assert.match(source('ui/shared/rpc.js'), /connection\.rpc\.call/);
});
test('one stable player instance survives every Studio tab', () => {
  const app = runtime(); const render = () => app.render(() => app.studio.WorkMainPanel({ connection: {} }));
  let tree = render();
  for (const label of ['Music', 'Git Mesh', 'Messages']) {
    const nav = nodes(tree).find(n => n.type === 'nav');
    nodes(nav).find(n => n.type === 'button' && (n.props?.['aria-label'] === label || n.children.includes(label) || nodes(n).some(c => c.children?.includes(label)))).props.onClick();
    tree = render();
    const players = nodes(tree).filter(n => n.type === app.studio.ItunesPlayer);
    assert.equal(players.length, 1);
    assert.equal(players[0].props.key, 'persistent-player');
    assert.equal(players[0].props.popoverOpen, label === 'Music');
  }
});
test('persistent footer exposes previous, play, next, volume and playlist controls', () => {
  const app = runtime(); const tree = app.render(() => app.studio.ItunesPlayer({ connection: {}, musicActive: true, popoverOpen: true, setPopoverOpen: () => {} }));
  assert.equal(tree.type, 'footer');
  for (const label of ['Previous track', 'Play', 'Next track', 'Search music', 'Add to playlist', 'Player volume']) assert.ok(nodes(tree).some(n => n.props?.['aria-label'] === label), label);
  assert.equal(nodes(tree).filter(n => n.props?.className === 'wk-audio-popover wk-player-expanded').length, 1);
  assert.match(player, /navigator\.clipboard\.writeText\(link\)/);
  assert.match(player, /You have to lock in/);
  assert.match(player, /onClick: \(\) => runSearch\('You have to lock in'\)/);
  assert.match(player, /wk-yt-stats/);
  assert.match(player, /playerAction\('musicSearch'/);
  assert.match(player, /playerAction\('musicPlay'/);
});
test('frame geometry belongs to BubbleHUD and narrow layouts follow container width', () => {
  const panelRule = styles.match(/\.wk-global-panel \{([^}]+)\}/)[1];
  assert.doesNotMatch(panelRule, /inset:/);
  assert.match(panelRule, /container-type: inline-size/);
  assert.match(styles, /@container \(max-width: 620px\)/);
  assert.match(styles, /\.wk-player-footer \{[^}]*height: 38px/);
  assert.doesNotMatch(styles, /@media \(max-width:/);
  assert.doesNotMatch(scripts, /'wk-header-brand' \}, \[h\(InfinityLogo/);
});
test('new links verify real GitHub profiles without invented presence', () => {
  const mainPanel = source('ui/features/shell/WorkMainPanel.js');
  assert.match(mainPanel, /'verifyPeerUser', \{ username \}/);
  assert.match(mainPanel, /avatarUrl: user\.avatarUrl \|\| null/);
  assert.match(mainPanel, /status: user\.status \|\| 'offline'/);
  assert.doesNotMatch(scripts, /avatars\.githubusercontent\.com\/\$\{username\}/);
});

test('intel tab renders reader and handles save to note without error', () => {
  const app = runtime();
  const render = () => app.render(() => app.studio.WorkMainPanel({ connection: {}, requestedTab: 'intel' }));
  let tree = render();
  const intelNode = nodes(tree).find(n => typeof n.type === 'function' && n.type.name === 'IntelReaderView');
  assert.ok(intelNode);
  const intelApp = runtime();
  const intelTree = intelApp.render(() => intelNode.type({ connection: {}, onBack: () => {} }));
  assert.ok(nodes(intelTree).some(n => n.type === 'div' && n.props?.className === 'wk-center-intel-view'));
  assert.ok(nodes(intelTree).some(n => n.type === 'input' && n.props?.['aria-label'] === 'Enter URL or search web'));
  assert.ok(!nodes(intelTree).some(n => n.children?.includes('/feeds')));
});

test('Chats rail uses Search placeholder, hides Collaborators count, and supports right-click collaborator menu', () => {
  const app = runtime();
  const tree = app.render(() => app.studio.WorkMainPanel({ connection: {}, requestedTab: 'messages' }));
  const all = nodes(tree);
  assert.ok(all.some(n => n.type === 'input' && n.props?.placeholder === 'Search'));
  assert.ok(!all.some(n => n.type === 'input' && n.props?.placeholder === 'Search conversations'));
  const mainPanelSrc = source('ui/features/shell/WorkMainPanel.js');
  assert.ok(mainPanelSrc.includes('formatPeerDisplayName'));
  assert.ok(mainPanelSrc.includes('Revert Delete'));
  assert.ok(mainPanelSrc.includes('wk-revert-delete-stack'));
  assert.ok(mainPanelSrc.includes('Unlink & Delete Chat'));
});
