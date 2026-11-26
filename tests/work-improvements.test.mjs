import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { UI_SCRIPTS, UI_STYLES } from '../scripts/build-ui.mjs';
import { RealtimeRelayBus } from '../lib/engines/realtime-relay.js';
import { runGit, stageAndCommit, getWorkspaceGitOverview, stageGitFiles, unstageGitFiles, discardFileChanges, switchGitBranch, parseGithubRemote } from '../lib/engines/git-engine.js';

const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

test('workSurface synchronizes shared tab, peer, repo, and settings across mounts', () => {
  const ctx = vm.createContext({
    useState: i => [typeof i === 'function' ? i() : i, () => {}],
    useRef: v => ({ current: v }),
    useEffect: () => {},
    window: { innerWidth: 1280, innerHeight: 800, localStorage: { getItem: () => null, setItem: () => {} } },
  });
  vm.runInContext(read('ui/features/shell/window-geometry.js') + ';globalThis.ws = workSurface;', ctx);
  const seen = [];
  const unsub = ctx.ws.subscribeState(s => seen.push(s));
  ctx.ws.setTab('intel');
  assert.equal(ctx.ws.getState().workTab, 'intel');
  assert.equal(ctx.ws.getState().managementOpen, false);
  ctx.ws.setTab('settings');
  assert.equal(ctx.ws.getState().managementOpen, true);
  ctx.ws.updateState({ workspaceDir: 'D:\\repo', isHost: true });
  assert.equal(ctx.ws.getState().workspaceDir, 'D:\\repo');
  assert.equal(ctx.ws.getState().isHost, true);
  assert.ok(seen.length >= 3);
  unsub();
});

test('NotesBrainstormView parses offline Mermaid mindmap and flowchart diagrams', () => {
  const ctx = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: i => [typeof i === 'function' ? i() : i, () => {}],
    useEffect: () => {},
    useRef: v => ({ current: v }),
    useMemo: fn => fn(),
    SvgIcon: 'svg',
    Icons: new Proxy({}, { get: (_, k) => k }),
  });
  vm.runInContext(read('ui/features/chat/NotesBrainstormView.js') + ';globalThis.parse = parseMermaidDiagram; globalThis.Preview = MermaidSvgPreview;', ctx);

  const mm = ctx.parse('mindmap\n  root((Core))\n    Chats\n      Voice\n    Repo');
  assert.equal(mm.kind, 'mindmap');
  assert.equal(mm.root.label, 'Core');
  assert.equal(mm.root.children.length, 2);
  assert.equal(mm.root.children[0].children[0].label, 'Voice');

  const flow = ctx.parse('graph TD\n  A[Start] --> B{Check?}\n  B -->|Yes| C[Ship]');
  assert.equal(flow.kind, 'flow');
  assert.equal(flow.nodes.length, 3);
  assert.equal(flow.edges.length, 2);
  assert.equal(flow.edges[1].label, 'Yes');

  const svg = ctx.Preview({ code: 'graph TD\n  A[Start] --> B[End]', zoom: 1 });
  assert.equal(svg.type, 'svg');
});

test('SettingsPanel focuses on Account (GitHub Sign in) and Workspace (Default clone folder) without Network & Collaborators', () => {
  const calls = [];
  const ctx = vm.createContext({
    React: { Fragment: 'fragment' },
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    SvgIcon: 'svg',
    Icons: new Proxy({}, { get: (_, k) => k }),
  });
  vm.runInContext(read('ui/features/settings/SettingsPanel.js') + ';globalThis.Panel = SettingsPanel;', ctx);
  const all = n => !n || typeof n !== 'object' ? [] : [n, ...n.children.flatMap(all)];
  const baseProps = {
    auth: { connected: true, user: { login: 'aoiuyy' }, maskedToken: 'ghp_***' },
    patInput: '', setPatInput: () => {}, patBusy: false,
    workConfig: { defaultParent: 'D:\\Code' },
    setWorkConfig: () => {},
    busy: false, updateInfo: { status: 'idle' },
    isHost: true,
    onClose: () => {}, onConnectGithub: () => {}, onDisconnectGithub: () => {},
    onStartDeviceLogin: () => calls.push('device-login'),
    onPublishUpdate: () => calls.push('release'),
    onRestartToUpdate: () => calls.push('restart'),
  };
  const tree = all(ctx.Panel(baseProps));
  const text = tree.flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  assert.ok(text.includes('Account'));
  assert.ok(text.includes('Workspace'));
  assert.ok(text.includes('Default clone folder'));
  assert.ok(!text.includes('Network & Collaborators'));
  assert.ok(!text.includes('Machine name'));
  assert.equal(tree.filter(n => n.type === 'button' && n.children.includes('Restart to Update')).length, 0);
  const releaseBtn = tree.find(n => n.type === 'button' && n.children.includes('Release'));
  assert.ok(releaseBtn);
  releaseBtn.props.onClick();
  const loggedOut = all(ctx.Panel({ ...baseProps, auth: { connected: false } }));
  const loggedOutText = loggedOut.flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  assert.ok(loggedOutText.includes('Sign in with GitHub'));
  loggedOut.find(n => n.type === 'button' && n.children.includes('Sign in with GitHub')).props.onClick();
  const clientNodes = all(ctx.Panel({ ...baseProps, isHost: false, updateInfo: { status: 'available', latestVersion: '4.6.2', assetId: 9 } }));
  assert.equal(clientNodes.filter(n => n.type === 'button' && n.children.includes('Release')).length, 0);
  const restartBtn = clientNodes.find(n => n.type === 'button' && n.children.includes('Restart to Update'));
  assert.ok(restartBtn);
  restartBtn.props.onClick();
  assert.deepEqual(calls, ['release', 'device-login', 'restart']);
});

test('ItunesPlayer reverts progressAnchor.playing on failed playback command', async () => {
  const code = read('ui/features/music/ItunesPlayer.js');
  assert.match(code, /progressAnchor\.current = \{ \.\.\.progressAnchor\.current, playing: wasPlaying \}/);
});

test('Full bundle builds cleanly with all 13 UI scripts and 4 stylesheets', () => {
  const template = read('ui/client.template.js');
  const styles = UI_STYLES.map(read).join('\n');
  const scripts = UI_SCRIPTS.map(read).join('\n');
  assert.ok(styles.includes('.wk-music-split.is-two-col'));
  assert.ok(scripts.includes('computeRadialOffsets'));
  assert.ok(scripts.includes('MermaidSvgPreview'));
  assert.ok(template.includes('/* WORK_COMPONENTS */'));
});

test('Focused improvements: 3-tab Notes, no /sync command, Commit & Share, IntelBrowser routes', () => {
  const notesSrc = read('ui/features/chat/NotesBrainstormView.js');
  assert.ok(notesSrc.includes("' Mindmap & Diagram'"));
  assert.ok(notesSrc.includes("'Auto Mindmap'"));
  assert.ok(notesSrc.includes("'Mermaid Diagram'"));
  assert.ok(!notesSrc.includes("' Mind Map Tree'"));

  const cmdSrc = read('lib/engines/chat-command.js');
  assert.ok(!cmdSrc.includes('/sync'));

  const repoMeshSrc = read('ui/features/repo/RepoMeshView.js');
  assert.ok(repoMeshSrc.includes('Commit & Share'));
  assert.ok(!repoMeshSrc.includes('wk-repo-menu'));

  const mainPanelSrc = read('ui/features/shell/WorkMainPanel.js');
  assert.ok(mainPanelSrc.includes('handleCommitAndShare'));
  assert.ok(mainPanelSrc.includes('workConfig?.defaultParent'));

  const intelRoutesSrc = read('lib/rpc/intel.routes.js');
  for (const fn of ['intelBrowserStatus', 'intelBrowserNavigate', 'intelBrowserSnapshot', 'intelBrowserInput', 'intelBrowserResize', 'intelBrowserDarkMode', 'intelBrowserClip', 'intelBrowserStop']) {
    assert.ok(intelRoutesSrc.includes(fn));
  }

  const musicRoutesSrc = read('lib/rpc/music.routes.js');
  for (const fn of ['musicVideoMode', 'musicVideoFrame', 'musicVideoInput', 'musicHome']) {
    assert.ok(musicRoutesSrc.includes(fn));
  }

  const mainPanelClean = read('ui/features/shell/WorkMainPanel.js');
  assert.ok(!mainPanelClean.includes('wk-center-header'));
  assert.ok(!mainPanelClean.includes('wk-host-release-btn'));
  assert.ok(mainPanelClean.includes('wk-chat-drawer-fab'));
  assert.ok(mainPanelClean.includes('wk-chat-date-divider'));

  const intelUiSrc = read('ui/features/intel/IntelReaderView.js');
  assert.ok(!intelUiSrc.includes('Hacker News'));
  assert.ok(!intelUiSrc.includes('wk-intel-live-bar'));

  const chatRoutesSrc = read('lib/rpc/chat.routes.js');
  assert.ok(chatRoutesSrc.includes('isMachineDm'));

  const playerSrc = read('ui/features/music/ItunesPlayer.js');
  assert.ok(playerSrc.includes('wk-music-resizer'));
  assert.ok(playerSrc.includes('wk-vinyl-disc'));
  assert.ok(playerSrc.includes('wk-transport-dock'));
  assert.ok(playerSrc.includes('Audio Only'));
  assert.ok(playerSrc.includes('musicVideoInput'));
  assert.ok(!playerSrc.includes("searching ? 'Wait' : 'Search'"));
  assert.ok(playerSrc.includes('Icons.Search'));
});

test('RealtimeRelayBus encrypts/decrypts E2EE payloads and canonical DM room IDs match by GitHub login', async () => {
  const bus = new RealtimeRelayBus({ disabled: true });
  const { topic, wire } = bus.encrypt('dm-alice--bob', 'aoiuyy/dsh-work-vault', { type: 'chat-event', message: { id: 'm1', content: 'secret-e2ee-hello' } });
  assert.match(topic, /^dsh-work\/v2\/[a-f0-9]{28}$/);
  assert.ok(!wire.toString('utf8').includes('secret-e2ee-hello'));
  const dec = bus.decrypt('dm-alice--bob', 'aoiuyy/dsh-work-vault', wire);
  assert.equal(dec.message.content, 'secret-e2ee-hello');
  assert.throws(() => bus.decrypt('dm-alice--bob', 'wrong-secret', wire));

  const ctx = vm.createContext({ fetch: async () => ({ ok: false }) });
  vm.runInContext(read('ui/shared/rpc.js') + ';globalThis.buildRoomId = buildRoomId;', ctx);
  assert.equal(ctx.buildRoomId('WK-A', { peerToken: 'KHOI', username: 'Khoi1709' }, 'aoiuyy'), 'dm-aoiuyy--khoi1709');
  assert.equal(ctx.buildRoomId('WK-B', { peerToken: 'AOIUYY', username: 'aoiuyy' }, 'Khoi1709'), 'dm-aoiuyy--khoi1709');
});

test('Engineer Git workbench helpers stage, unstage, switch branch, discard, and parse GitHub origin', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-eng-git-'));
  try {
    await runGit(['init', '-b', 'main'], dir);
    await runGit(['config', 'user.email', 'dev@dsh.local'], dir);
    await runGit(['config', 'user.name', 'Dev'], dir);
    await fs.writeFile(path.join(dir, 'index.js'), 'export const a = 1;\n', 'utf8');
    await stageAndCommit(dir, { message: 'init' });
    await runGit(['remote', 'add', 'origin', 'https://github.com/aoiuyy/demo-app.git'], dir);

    assert.deepEqual(parseGithubRemote('git@github.com:aoiuyy/demo-app.git'), {
      owner: 'aoiuyy',
      repo: 'demo-app',
      htmlUrl: 'https://github.com/aoiuyy/demo-app',
    });

    await switchGitBranch(dir, 'feat/ui', { create: true });
    await fs.writeFile(path.join(dir, 'index.js'), 'export const a = 2;\n', 'utf8');
    await stageGitFiles(dir, ['index.js']);
    let ov = await getWorkspaceGitOverview(dir);
    assert.equal(ov.currentBranch || ov.branch, 'feat/ui');
    assert.deepEqual(ov.staged, ['index.js']);
    assert.equal(ov.githubRemote.owner, 'aoiuyy');

    await unstageGitFiles(dir, ['index.js']);
    ov = await getWorkspaceGitOverview(dir);
    assert.deepEqual(ov.staged, []);
    assert.deepEqual(ov.modified, ['index.js']);

    await discardFileChanges(dir, 'index.js');
    ov = await getWorkspaceGitOverview(dir);
    assert.equal(ov.totalChanges, 0);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
