import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../ui/features/repo/RepoCard.js', import.meta.url), 'utf8');
const mainPanel = await readFile(new URL('../ui/features/shell/WorkMainPanel.js', import.meta.url), 'utf8');
const repoMesh = await readFile(new URL('../ui/features/repo/RepoMeshView.js', import.meta.url), 'utf8');
function context() {
  const calls = [];
  const ctx = vm.createContext({ useState: value => [value, () => {}], h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== false && v != null) }), navigator: { clipboard: { writeText: async text => calls.push(text) } } });
  vm.runInContext(source, ctx);
  return { ctx, calls };
}
function nodes(node) { return typeof node !== 'object' || node == null ? [] : [node, ...node.children.flatMap(nodes)]; }
test('diff review numbers additions/deletions correctly and preserves copy source', async () => {
  const { ctx, calls } = context();
  ctx.patch = '@@ -4,2 +4,2 @@\n context\n-old\n+new';
  const rows = vm.runInContext('diffRows(patch)', ctx);
  assert.equal(rows[2].old, 5); assert.equal(rows[2].next, '');
  assert.equal(rows[3].next, 5); assert.equal(rows[3].old, '');
  const view = vm.runInContext('DiffPreview({text:patch})', ctx);
  assert.ok(nodes(view).some(n => n.props.className === 'wk-diff-line add'));
  await nodes(view).find(n => n.type === 'button').props.onClick();
  assert.equal(calls[0], ctx.patch);
});
test('native RepoCard routes context-smart 2-button actions with exact metadata', () => {
  const { ctx, calls } = context();
  for (const key of ['onClone', 'onDiff', 'onMerge', 'onPush']) ctx.props = ctx.props || {};
  ctx.props = { message: { content: 'Shared', created_at: '2026-01-01T00:00:00Z' }, meta: { repoName: 'demo', branch: 'collab/tester', peerUsername: 'tester', commitHash: 'abcdef123', vaultOwner: 'owner', vaultRepo: 'vault' }, hasLocal: false, busy: false };
  for (const key of ['onClone', 'onDiff', 'onMerge', 'onPush']) ctx.props[key] = meta => calls.push([key, meta]);
  const remoteButtons = nodes(vm.runInContext('RepoCard(props)', ctx)).filter(n => n.type === 'button');
  assert.deepEqual(remoteButtons.map(n => n.children[0]), ['Download & Clone', 'Inspect Diff']);
  assert.equal(remoteButtons[0].props.disabled, false);
  assert.equal(remoteButtons[1].props.disabled, true);
  remoteButtons[0].props.onClick();

  ctx.props.hasLocal = true;
  const localButtons = nodes(vm.runInContext('RepoCard(props)', ctx)).filter(n => n.type === 'button');
  assert.deepEqual(localButtons.map(n => n.children[0]), ['Pull & Merge', 'Inspect Diff']);
  for (const button of localButtons) { assert.equal(button.props.disabled, false); button.props.onClick(); }
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(([k]) => k), ['onClone', 'onMerge', 'onDiff']);
  assert.ok(calls.every(([, meta]) => meta === ctx.props.meta));
  ctx.props.meta = { repoName: 'legacy' };
  assert.ok(nodes(vm.runInContext('RepoCard(props)', ctx)).filter(n => n.type === 'button').every(n => n.props.disabled));
});
test('window header omits redundant Git chrome and exposes vector maximize + close controls', async () => {
  const hudSource = [
    await readFile(new URL('../ui/features/shell/window-geometry.js', import.meta.url), 'utf8'),
    await readFile(new URL('../ui/features/shell/BubbleHUD.js', import.meta.url), 'utf8'),
  ].join('\n');
  const ctx = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(v => v !== false && v != null) }), React: { Fragment: 'fragment' },
    useState: value => [typeof value === 'function' ? value() : value, () => {}], useRef: current => ({ current }), useEffect: () => {},
    SvgIcon: props => ({ type: 'svg', props }), BUBBLE_RADIAL_ICONS: { chat: '', repo: '', music: '', intel: '' },
    window: { innerWidth: 1365, innerHeight: 767, localStorage: { getItem: () => null } }, WorkMainPanel: () => {}, InfinityLogo: () => {},
  });
  vm.runInContext(hudSource + ';globalThis.surface = workSurface;', ctx);
  const tree = vm.runInContext('BubbleHUD({connection:{}})', ctx);
  const list = nodes(tree);
  const text = list.flatMap(node => node.children.filter(v => typeof v === 'string')).join(' ');
  assert.ok(!text.includes('No branch'));
  assert.equal(list.find(node => node.props['aria-label'] === 'Sync Vault Git'), undefined);
  assert.equal(list.find(node => node.props['aria-label'] === 'Window size preset'), undefined);
  assert.ok(list.find(node => node.props['aria-label'] === 'Maximize Work window'));
  assert.ok(list.find(node => node.props['aria-label'] === 'Close Work panel'));
});
test('Repo frontend uses Vault Git only, preserves explicit commit and recent storage key', () => {
  const share = mainPanel.slice(mainPanel.indexOf('      const shareDirectory ='), mainPanel.indexOf('      const handleResolveConflict'));
  assert.ok(share.includes("'shareRepository'"));
  assert.ok(share.includes("'cloneSharedRepository'"));
  assert.ok(share.includes("'syncGitRepository'"));
  assert.ok(share.includes("'commitRepository'"));
  assert.ok(!/sendRepoDirectLan|publishTool|downloadTool/.test(share));
  assert.ok(mainPanel.includes("localStorage.setItem('dsh_work_recent_repos'"));
  assert.ok(repoMesh.includes('Recent repositories and changes'));
});
