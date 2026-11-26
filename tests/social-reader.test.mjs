import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createIntelRoutes } from '../lib/rpc/intel.routes.js';

test('Intel exposes only Live Browser routes after /feeds removal', async () => {
  const routes = createIntelRoutes(null);
  assert.equal('socialBrowse' in routes, false);
  assert.equal('social/browse' in routes, false);
  assert.equal('socialRead' in routes, false);
  assert.ok('intelBrowserNavigate' in routes);
  assert.ok('intelBrowserSnapshot' in routes);
  const intelUi = await fs.readFile(new URL('../ui/features/intel/IntelReaderView.js', import.meta.url), 'utf8');
  assert.ok(!intelUi.includes('/feeds'));
  assert.ok(!intelUi.includes('socialBrowse'));
});
