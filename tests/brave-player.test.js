import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { extractVideoId, isYouTubeUrl, BravePlayer } from '../lib/engines/brave-player.js';

test('extractVideoId handles various formats', () => {
  assert.equal(extractVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://youtu.be/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(extractVideoId('not-a-video-id'), null);
});

test('isYouTubeUrl checks domain safely', () => {
  assert.equal(isYouTubeUrl('https://www.youtube.com/watch?v=123'), true);
  assert.equal(isYouTubeUrl('https://youtu.be/123'), true);
  assert.equal(isYouTubeUrl('https://attacker.com/fake-youtube'), false);
  assert.equal(isYouTubeUrl('javascript:alert(1)'), false);
});

test('BravePlayer initializes and manages playlist file', async () => {
  const tmpPlaylist = path.join(process.cwd(), 'temp', 'test-playlist.json');
  try {
    const player = new BravePlayer({ playlistFile: tmpPlaylist });
    const st = player.status();
    assert.equal(typeof st.installed, 'boolean');

    const defaultList = await player.loadPlaylist();
    assert.ok(Array.isArray(defaultList));
    assert.ok(defaultList.length >= 1);

    const testList = [{ id: 'test1', title: 'Song 1', url: 'https://youtube.com/watch?v=test1' }];
    await player.savePlaylist(testList);
    const loaded = await player.loadPlaylist();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, 'test1');
  } finally {
    await fsp.rm(tmpPlaylist, { force: true }).catch(() => {});
  }
});
