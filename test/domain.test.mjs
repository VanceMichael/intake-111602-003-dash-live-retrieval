import test from 'node:test';
import assert from 'node:assert/strict';
import { startSource } from '../source/service.mjs';
import { SourceClient } from '../src/transport.mjs';
import { decode } from '../src/decode.mjs';

test('直播窗口滚动后旧片段过期，未来片段不等于缺失', async () => {
  const source = await startSource({ scenario: 'transition' });
  try {
    const client = new SourceClient(source.base);
    assert.equal((await client.request('/media/a/0.m4s')).status, 200);
    assert.equal((await client.request('/media/a/16.m4s')).status, 404);
    await client.control({ action: 'advance' });
    assert.equal((await client.request('/media/a/0.m4s')).status, 410);
    assert.equal((await client.request('/media/a/16.m4s')).status, 200);
    const manifest = decode((await client.request('/live.mpd')).bytes);
    assert.equal(manifest.periods[0].representations[0].id, 'camera-a');
  } finally { await source.close(); }
});
