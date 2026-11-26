import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleClientBundle } from '../scripts/build-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const components = await readFile(new URL('../ui/features/chat/ChatChannels.js', import.meta.url), 'utf8');
const markdownSource = await readFile(new URL('../ui/shared/markdown.js', import.meta.url), 'utf8');
const rpcSource = await readFile(new URL('../ui/shared/rpc.js', import.meta.url), 'utf8');
const iconsSource = await readFile(new URL('../ui/shared/icons.js', import.meta.url), 'utf8');
const mainPanelSource = await readFile(new URL('../ui/features/shell/WorkMainPanel.js', import.meta.url), 'utf8');

function renderContext() {
  const calls = [];
  const context = vm.createContext({
    h: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity).filter(Boolean) }),
    useState: value => [value, () => {}], useEffect: () => {}, useRef: value => ({ current: value }), renderMessageMarkdown: value => value,
    navigator: { clipboard: { writeText: async value => calls.push(value) } },
    window: { confirm: () => true, matchMedia: () => ({ matches: true }) },
    document: { getElementById: id => ({ scrollIntoView: options => calls.push([id, options.behavior]), focus: () => {} }) },
  });
  vm.runInContext([iconsSource, rpcSource, components].join('\n'), context);
  return { context, calls };
}
function all(node) { return !node || typeof node !== 'object' ? [] : [node, ...node.children.flatMap(all)]; }

test('stream actions enforce ownership in UI and invoke canonical contracts', async () => {
  const { context, calls } = renderContext();
  context.props = { message: { id: 'm1', senderName: 'Peer', content: 'hello', created_at: 1, isPinned: true }, isMe: false, peer: {}, profile: {}, onAction: (...args) => calls.push(args), onReply: () => {}, notify: () => {} };
  const row = vm.runInContext('DiscordMessageRow(props)', context);
  const buttons = all(row).filter(n => n.type === 'button');
  const rowText = all(row).flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  assert.equal(row.type, 'article');
  assert.ok(!rowText.includes('This machine'));
  assert.ok(!rowText.includes('E2EE'));
  assert.ok(!buttons.some(n => n.props['aria-label'] === 'Edit' || n.props['aria-label'] === 'Delete message'));
  assert.ok(!buttons.some(n => n.props['aria-label'] === 'React heart' || n.props['aria-label'] === 'React thumbs'));
  buttons.find(n => n.props['aria-label'] === 'Unpin').props.onClick();
  assert.equal(calls[0][0], 'pinChatMessage');
  assert.equal(calls[0][2].isPinned, false);
  buttons.find(n => n.props['aria-label'] === 'React fire').props.onClick();
  assert.equal(calls[1][2].reaction, 'fire');
  await buttons.find(n => n.props['aria-label'] === 'Copy text').props.onClick();
  assert.equal(calls[2], 'hello');
  context.props.isMe = true;
  const own = all(vm.runInContext('DiscordMessageRow(props)', context));
  assert.ok(own.some(n => n.props['aria-label'] === 'Edit'));
  assert.ok(own.some(n => n.props['aria-label'] === 'Delete message'));
});

test('voice messages render compact audio pill without file size or download button', () => {
  const { context } = renderContext();
  context.props = {
    message: { id: 'v1', type: 'voice', created_at: 1, fileMeta: { name: 'voice-note.webm', mimeType: 'audio/webm', size: 39800 } },
    connection: {},
    notify: () => {},
  };
  const attachment = vm.runInContext('ChatAttachment(props)', context);
  assert.equal(attachment.type.name, 'CompactAudioPill');
  const pill = attachment.type(attachment.props);
  const nodes = all(pill);
  const text = nodes.flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  assert.equal(pill.props.className, 'wk-audio-pill');
  assert.ok(nodes.some(n => n.props['aria-label'] === 'Play voice note'));
  assert.ok(nodes.some(n => n.props['aria-label'] === 'Voice note progress'));
  assert.ok(nodes.some(n => n.props['aria-label'] === 'Mute voice note'));
  assert.ok(!text.includes('Download'));
  assert.ok(!text.includes('KB'));
  assert.ok(!text.includes('voice-note.webm'));
});

test('reply quotes navigate to deterministic stream targets with reduced motion', () => {
  const { context, calls } = renderContext();
  context.props = { message: { id: 'reply', created_at: 1, replyTo: { id: 'source', senderName: 'Peer', content: 'quoted' } }, peer: {}, profile: {}, notify: () => {} };
  const row = vm.runInContext('DiscordMessageRow(props)', context);
  all(row).find(n => n.props.className === 'wk-reply-quote').props.onClick();
  assert.deepEqual([...calls[0]], ['wk-chat-source', 'auto']);
});

test('drawer derives pinned, media, files and safe external links from current conversation', () => {
  const { context } = renderContext();
  context.props = { messages: [{ id: 'a', isPinned: true, content: 'https://example.com/a', fileMeta: { name: 'pic.png', mimeType: 'image/png' } }, { id: 'b', content: 'https://example.com/a https://example.org/b', fileMeta: { name: 'gone', deletedAt: 'now' } }], peer: { alias: 'general', peerToken: 'channel:general' }, onClose: () => {} };
  const nodes = all(vm.runInContext('ChatManagementDrawer(props)', context));
  const text = nodes.flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  for (const label of ['Pinned messages (1)', 'Photos / videos (1)', 'Files (1)', 'Links (2)']) assert.ok(text.includes(label));
  const links = nodes.filter(n => n.type === 'a');
  assert.equal(links.length, 2);
  assert.ok(links.every(n => n.props.rel === 'noopener noreferrer'));
});

test('code rendering copies exact code and never injects source HTML', async () => {
  const { context, calls } = renderContext();
  vm.runInContext(markdownSource, context);
  context.text = '```js\nconst value = "<script>";\n```';
  const blocks = vm.runInContext('renderMessageMarkdown(text)', context);
  const nodes = blocks.flatMap(all);
  assert.ok(nodes.some(n => n.props.className === 'wk-code-keyword'));
  assert.ok(!nodes.some(n => n.props.dangerouslySetInnerHTML));
  await nodes.find(n => n.type === 'button').props.onClick({ currentTarget: {} });
  assert.equal(calls[0], 'const value = "<script>";\n');
});

test('drawer omits Profile & Shared header, empty Links, and supports nickname editing', () => {
  const { context } = renderContext();
  const saved = [];
  context.props = {
    messages: [{ id: 'a', isPinned: true, content: 'no links here' }],
    peer: { alias: '@khoi1709', username: 'khoi1709', peerToken: 'khoi1709', status: 'online' },
    peerDisplayName: '@khoi1709',
    onSaveNickname: (peer, val) => saved.push([peer.username, val]),
    onClose: () => {},
  };
  const nodes = all(vm.runInContext('ChatManagementDrawer(props)', context));
  const text = nodes.flatMap(n => n.children.filter(c => typeof c === 'string')).join(' ');
  assert.ok(!text.includes('Profile & Shared'));
  assert.ok(!text.includes('Links (0)'));
  assert.ok(nodes.some(n => n.props['aria-label'] === 'Nickname'));
  assert.ok(text.includes('@khoi1709'));
  assert.ok(!text.includes('@@khoi1709'));
  nodes.find(n => n.props.className === 'wk-nickname-form').props.onSubmit({ preventDefault() {} });
  assert.equal(saved.length, 1);
});

test('generated bundle matches source-only component pipeline', async () => {
  const bundle = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const expected = await assembleClientBundle(root);
  assert.ok(bundle === expected, 'Bundle must match source and build banner exactly');
  assert.ok(mainPanelSource.includes('navigator.mediaDevices.getUserMedia({ audio: true })'));
  assert.ok(mainPanelSource.includes('stream.getTracks().forEach(track => track.stop())'));
});
