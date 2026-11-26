import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { BravePlayer, buildSearchSp, extractSearchResults, formatCompactCount, formatCompactTime } from '../lib/engines/brave-player.js';

const ready = p => { p.connection = { call: async () => {}, close() {} }; p.intendedPlay = true; p.lastProgressAt = 1000; return p; };
const state = { title: 'Original', errorCode: 150, volume: 0.6, currentTime: 0, ended: false };
const free = { id: 'abc123', title: 'An alternate', user: { name: 'Independent artist' }, is_streamable: true, artwork: { '480x480': 'https://example.test/art' } };

test('offscreen launch flags keep native audio without headless or shell controls', async () => {
  const source = await fs.readFile(new URL('../lib/engines/brave-player.js', import.meta.url), 'utf8');
  for (const flag of ['--window-position=-32000,-32000', '--window-size=900,700', '--new-window', '--no-first-run', '--autoplay-policy=no-user-gesture-required']) assert.ok(source.includes(flag));
  assert.ok(!source.includes('--headless')); assert.ok(!source.includes('powershell'));
});

test('watchdog includes buffering, respects pause and 15 second cooldown', async () => {
  const p = ready(new BravePlayer()); let kicks = 0;
  p.command = async () => { kicks++; };
  await p.maintainPlayback({ ...state, errorCode: 0, buffering: true }, 15999); assert.equal(kicks, 0);
  await p.maintainPlayback({ ...state, errorCode: 0, buffering: true }, 16000); assert.equal(kicks, 1);
  await p.maintainPlayback({ ...state, errorCode: 0 }, 17000); assert.equal(kicks, 1);
  p.intendedPlay = false;
  await p.maintainPlayback({ ...state, errorCode: 0 }, 50000); assert.equal(kicks, 1);
});

test('concurrent readState shares one evaluation and confirms dialogs', async () => {
  const p = ready(new BravePlayer()); let calls = 0, release;
  p.evaluate = () => { calls++; return new Promise(r => { release = r; }); };
  const a = p.readState(), b = p.readState(); assert.equal(calls, 1); release({ currentTime: 0 });
  assert.equal((await a).provider, 'youtube'); await b;
  let clicked = 0;
  p.evaluate = async expression => vm.runInNewContext(expression, { URL, location: { href: 'https://youtube.com/watch?v=abcdefghijk' }, document: { title: 'Track', querySelector: () => null, getElementById: () => null, querySelectorAll: q => q.startsWith('yt-confirm') ? [{ textContent: 'Still watching?', querySelector: () => ({ click() { clicked++; } }) }] : [] } });
  await p.readState(); assert.equal(clicked, 1);
});

test('Audius fallback is bounded, free-only, and reports failures', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls++; assert.match(url, /api\.audius\.co\/v1\/tracks\/search\?query=Original&limit=1/); assert.ok(options.signal); return { ok: true, json: async () => ({ data: [{ ...free, is_stream_gated: true }] }) }; });
  const p = ready(new BravePlayer()); p.evaluate = async () => { throw new Error('must not play gated track'); };
  await p.tryFallback(state); await p.tryFallback(state);
  assert.equal(calls, 1); assert.match(p.fallbackError, /No playable free/); assert.equal(p.fallback, null);
});

test('Audius timeout surfaces one bounded failure without throwing', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('search timed out'); });
  const p = ready(new BravePlayer());
  await p.tryFallback(state); await p.tryFallback(state);
  assert.equal(calls, 1); assert.match(p.fallbackError, /search timed out/);
});

test('Audius uses same page, replaces old audio, exposes honest metadata and commands never restart YouTube', async t => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ data: [free] }) }));
  const p = ready(new BravePlayer()); const expressions = []; p.evaluate = async expression => { expressions.push(expression); return true; };
  await p.tryFallback(state); assert.equal(p.fallback.title, free.title); assert.equal(p.fallback.fallbackOriginalTitle, 'Original');
  assert.match(expressions[0], /old\.remove\(\)/); assert.match(expressions[0], /document\.createElement\('audio'\)/);
  await p.command('pause'); assert.equal(p.intendedPlay, false);
  await p.command('play'); assert.match(expressions.at(-1), /\? null : document.getElementById/);
});

test('pending fallback cannot replace a new selection or restart after stop/pause', async t => {
  let resolve;
  t.mock.method(globalThis, 'fetch', () => new Promise(r => { resolve = r; }));
  for (const action of ['selection', 'stop', 'pause']) {
    const p = ready(new BravePlayer()); let evaluated = 0;
    p.evaluate = async () => { evaluated++; return true; };
    const pending = p.tryFallback(state);
    if (action === 'selection') p.generation++;
    if (action === 'stop') await p.stop();
    if (action === 'pause') await p.command('pause');
    const before = evaluated;
    resolve({ ok: true, json: async () => ({ data: [free] }) }); await pending;
    assert.equal(evaluated, before); assert.equal(p.fallback, null);
  }
});

test('host queue advances, repeat one/all/off persist across commands and cleanup stops polling', async () => {
  const p = ready(new BravePlayer()); p.queue = [{ id: 'abcdefghijk' }, { id: '12345678901' }];
  p.lastRequestedUrl = 'https://youtube.com/watch?v=12345678901'; let played = null;
  p.play = async id => { played = id; };
  await p.command('replayMode', 'one'); await p.advanceQueue(1, true); assert.equal(played, '12345678901');
  await p.command('loop', false, 'all'); await p.advanceQueue(1, true); assert.equal(played, 'abcdefghijk');
  await p.command('replayMode', 'off'); played = null; await p.advanceQueue(1, true); assert.equal(played, null); assert.equal(p.intendedPlay, false);
  let closed = 0; p.connection = { call: async () => {}, close() { closed++; } }; p.startPolling(); await p.stop();
  assert.equal(p.pollTimer, null); assert.equal(p.connection, null); assert.equal(closed, 1);
});

test('compact view count and time formatters strip verbose labels', () => {
  assert.equal(formatCompactCount('3,712,345 views'), '3.7M');
  assert.equal(formatCompactCount('2.5K watching'), '2.5K');
  assert.equal(formatCompactCount('471K views'), '471K');
  assert.equal(formatCompactCount('2 views'), '2');
  assert.equal(formatCompactCount('No views'), '');
  assert.equal(formatCompactTime('3 months ago'), '3mo ago');
  assert.equal(formatCompactTime('10 hours ago'), '10h ago');
  assert.equal(formatCompactTime('Streamed 2 days ago'), '2d ago');
});

test('buildSearchSp encodes YouTube Type, Upload date, Duration and Sort filters accurately', () => {
  assert.equal(buildSearchSp({}), '');
  assert.equal(buildSearchSp({ type: 'channel' }), 'EgIQAg==');
  assert.equal(buildSearchSp({ type: 'playlist' }), 'EgIQAw==');
  assert.equal(buildSearchSp({ type: 'video', uploadDate: 'today', sortBy: 'views' }), 'CAMSBAgCEAE=');
  assert.equal(buildSearchSp({ type: 'channel', uploadDate: 'today', duration: 'short' }), 'EgIQAg==');
});

test('extractSearchResults parses channels, playlists and single-row channel videos when requested', () => {
  const data = {
    contents: {
      sectionListRenderer: {
        contents: [{
          itemSectionRenderer: {
            contents: [
              {
                channelRenderer: {
                  channelId: 'UCSJ4gkVC6NrvII8umztf0Ow',
                  title: { simpleText: 'Lofi Girl' },
                  subscriberCountText: { simpleText: '@LofiGirl' },
                  videoCountText: { simpleText: '15.8M subscribers' },
                  navigationEndpoint: { commandMetadata: { webCommandMetadata: { url: '/@LofiGirl' } } },
                  thumbnail: { thumbnails: [{ url: '//yt3.ggpht.com/avatar.jpg' }] },
                },
              },
              {
                lockupViewModel: {
                  contentId: 'nx32Ue0AAA0',
                  contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                  metadata: {
                    lockupMetadataViewModel: {
                      title: { content: 'a rainy night' },
                      metadata: {
                        contentMetadataViewModel: {
                          metadataRows: [{
                            metadataParts: [
                              { text: { content: '462K' }, leadingIcon: { name: 'PLAY_ARROW_OUTLINED' } },
                              { text: { content: '7d ago' } },
                            ],
                          }],
                        },
                      },
                    },
                  },
                },
              },
            ],
          },
        }],
      },
    },
  };
  const items = extractSearchResults(data, { includeChannels: true, defaultAuthor: 'Lofi Girl' });
  assert.equal(items.length, 2);
  assert.equal(items[0].type, 'channel');
  assert.equal(items[0].handle, '@LofiGirl');
  assert.equal(items[0].subscribers, '15.8M');
  assert.equal(items[0].thumbnail, 'https://yt3.ggpht.com/avatar.jpg');
  assert.equal(items[1].author, 'Lofi Girl');
  assert.equal(items[1].views, '462K');
  assert.equal(items[1].published, '7d ago');
});

test('video presentation isolates movie_player cleanly and defaults initial playback to hd720', async () => {
  const source = await fs.readFile(new URL('../lib/engines/brave-player.js', import.meta.url), 'utf8');
  assert.ok(source.includes('contain:none!important;transform:none!important'));
  assert.ok(source.includes('#masthead-container,#secondary,#below'));
  assert.ok(source.includes("this.videoMode ? \"'hd720'\" : \"'tiny'\""));
  assert.ok(!source.includes("this.videoMode ? \"'hd1080'\""));
});
