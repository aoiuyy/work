import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
test('player action boundary exposes RPC and transport failures without rejection', async () => {
  const context = vm.createContext({});
  vm.runInContext(source('ui/features/music/ItunesPlayer.js') + ';globalThis.run = runPlayerAction;', context);
  const errors = [];
  assert.equal((await context.run(async () => { throw new Error('offline'); }, 'musicState', {}, e => errors.push(e))).ok, false);
  assert.equal((await context.run(async () => ({ ok: false, error: { message: 'Seek rejected' } }), 'musicCommand', {}, e => errors.push(e))).ok, false);
  assert.equal((await context.run(async () => ({ ok: true, value: 1 }), 'musicPlay', {}, e => errors.push(e))).ok, true);
  assert.match(errors[0], /musicState: offline/);
  assert.match(errors[1], /Seek rejected/);
  assert.equal(errors.length, 2);
  assert.match(source('ui/features/music/ItunesPlayer.js'), /role: 'alert'/);
});
test('bubble clamp bounds tiny and normal viewports', () => {
  const context = vm.createContext({});
  vm.runInContext(source('ui/features/shell/window-geometry.js') + ';globalThis.clamp = clampBubble;', context);
  for (const [w,h] of [[320,600],[1920,1080],[24,24]]) for (const x of [-100,0,10000,NaN]) {
    const point = context.clamp(x, x, w, h);
    assert.ok(point.x >= 8 && point.y >= 8);
    assert.ok(point.x <= Math.max(8,w-51) && point.y <= Math.max(8,h-51));
  }
});
test('channels use explicit broadcast IDs, never DM identity', () => {
  const context = vm.createContext({});
  vm.runInContext(source('ui/features/chat/ChatChannels.js') + ';globalThis.make = channelPeer;', context);
  assert.equal(context.make('Team Alpha').peerToken, 'channel:team-alpha');
  assert.equal(context.make('!!!'), null);
  assert.equal(context.make('General').isChannel, true);
  assert.equal(context.make('team---alpha').peerToken, 'channel:team-alpha');
  assert.equal(context.make('a'.repeat(47) + ' b').peerToken, 'channel:' + 'a'.repeat(47));
});
test('generated module loads and registers one global poller owner', () => {
  let plugin;
  const React = { createElement: (...args) => args };
  vm.runInNewContext(source('client.js'), { window: { __ModuleLoader__: { load: module => { plugin = module.factory(() => React); } } } });
  const registrations = [];
  const ctx = { get: () => ({}), slots: { inject: (_name, fn) => fn(), register: (options, factory) => { registrations.push({ options, factory }); } } };
  plugin.apply(ctx);
  assert.equal(registrations.filter(r => r.options.name === 'shell.overlay').length, 1);
  assert.equal(registrations.filter(r => r.options.name === 'main').length, 1);
  assert.equal(registrations.find(r => r.options.name === 'main').factory()[0].name, 'WorkEntry');
});
test('command wire contract and ten-line expandable diff stay integrated', () => {
  const client = source('client.js');
  assert.match(client, /'executeChatCommand', \{ repoDir: workspaceDir, text, peerToken: activePeer.peerToken, roomId: activeRoomId \}/);
  assert.match(client, /setCommandResult\(value\)/);
  assert.match(client, /buildRoomId\(profile\?\.machineToken, activePeer(?:, myGithubLogin)?\)/);
  assert.match(client, /\[myUser, peer.peerToken\]\.sort\(\)/);
  assert.match(client, /error\?\.details\?\.message/);
  assert.match(client, /lines.slice\(0, 10\)/);
  assert.match(client, /onPointerCancel/);
  assert.match(client, /prefers-reduced-motion/);
  // shell.overlay is click-through; each interactive surface must opt back in.
  assert.match(client, /\.wk-global-panel\s*\{\s*pointer-events:\s*auto/);
  assert.match(client, /\.wk-bubble\s*\{\s*pointer-events:\s*auto/);
  assert.doesNotMatch(client, /transition:\s*all/);
});
