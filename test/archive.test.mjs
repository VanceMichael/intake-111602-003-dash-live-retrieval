import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Catalog } from '../src/catalog.mjs';
import { Archive } from '../src/archive.mjs';
import { SourceClient } from '../src/transport.mjs';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

async function makeArchive({ scenario, root, intervalMs = 60_000 }) {
  const source = await startSource({ scenario });
  const catalog = await new Catalog(join(root, 'catalog')).initialize();
  const archive = await new Archive({
    client: new SourceClient(source.base), catalog,
    root: join(root, 'archive'), intervalMs
  }).initialize();
  return { source, catalog, archive };
}

test('持续领取：初始化资料与窗口内媒体按 Representation 收妥，不做转码', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-basic-'));
  const { source, catalog, archive } = await makeArchive({ scenario: 'ordinary', root });
  try {
    archive.select(['hall\u0000camera-a']);
    const status = await archive.tick();
    assert.equal(status.counts.received, 3);
    assert.equal(status.counts.pending, 0);
    assert.equal(status.counts.expired, 0);
    // 初始化片段单独接收一次。
    assert.equal(status.initializations.length, 1);
    assert.match(status.initializations[0].url, /init\.mp4$/);
    // 原件可按摘要回读，字节与来源一致。
    const received = status.receivedRanges.flatMap(range => Array.from({ length: range.count }, (_, i) => range.from + i * 4));
    assert.deepEqual(received, [0, 4, 8]);
    const receipts = await catalog.list();
    const mediaReceipts = receipts.filter(item => item.context?.kind !== 'initialization');
    assert.equal(mediaReceipts.length, 3);
    for (const receipt of mediaReceipts) {
      const bytes = await catalog.object(receipt.digest);
      assert.equal(bytes.length, receipt.bytes);
      assert.equal(receipt.context.manifestPublishTime, '2026-10-12T01:00:12Z');
      assert.equal(receipt.context.representationId, 'camera-a');
      assert.match(receipt.context.mediaUrl, /\/media\/a\/\d+\.m4s$/);
    }
    // 再次核对不产生重复凭据。
    await archive.tick();
    assert.equal((await catalog.list()).filter(item => item.context?.kind !== 'initialization').length, 3);
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('一个机位失联时其他已授权机位独立接收，失联恢复后过期片段明确标记', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-isolation-'));
  const { source, catalog, archive } = await makeArchive({ scenario: 'cameras', root });
  try {
    archive.select(['hall\u0000camera-a', 'hall\u0000camera-b']);
    const first = await archive.tick();
    // camera-b 的 8.m4s 断连：camera-a 三个片段全收妥，camera-b 只收到 0/4。
    const aSlots = first.receivedRanges.filter(r => r.representationId === 'camera-a');
    const bReceived = first.receivedRanges.filter(r => r.representationId === 'camera-b');
    assert.equal(aSlots.reduce((sum, r) => sum + r.count, 0), 3);
    assert.equal(bReceived.reduce((sum, r) => sum + r.count, 0), 2);
    assert.ok(first.errors['hall\u0000camera-b'], '失联机位应记录错误');
    assert.equal(first.errors['hall\u0000camera-a'], undefined);
    // 两个机位的初始化资料都已独立接收。
    const initReps = first.initializations.map(item => item.url).sort();
    assert.deepEqual(initReps, ['/media/a/init.mp4', '/media/b/init.mp4']);

    await source.server.closeAllConnections?.();
    await new SourceClient(source.base).control({ action: 'advance' });
    const second = await archive.tick();
    // camera-a 继续收妥新片段；camera-b 失联期间的 8.m4s 已 410，标记为过期。
    const aTotal = second.receivedRanges.filter(r => r.representationId === 'camera-a')
      .reduce((sum, r) => sum + r.count, 0);
    assert.ok(aTotal >= 4);
    const bExpired = second.expiredRanges.filter(r => r.representationId === 'camera-b');
    assert.ok(bExpired.length > 0);
    const expiredTimes = bExpired.flatMap(r => Array.from({ length: r.count }, (_, i) => r.from + i * 4));
    assert.ok(expiredTimes.includes(8));
    // camera-b 恢复后新片段仍可接收。
    const bReceivedAfter = second.receivedRanges.filter(r => r.representationId === 'camera-b')
      .reduce((sum, r) => sum + r.count, 0);
    assert.ok(bReceivedAfter >= 3);
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('Period 空档不补零长度片段，状态里如实报告空档区间', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-gap-'));
  const { source, archive } = await makeArchive({ scenario: 'gap', root });
  try {
    archive.select(['opening\u0000cam-gap', 'closing\u0000cam-gap']);
    const status = await archive.tick();
    assert.equal(status.gaps.length, 1);
    assert.deepEqual(
      { after: status.gaps[0].afterPeriod, before: status.gaps[0].beforePeriod,
        start: status.gaps[0].startSeconds, end: status.gaps[0].endSeconds },
      { after: 'opening', before: 'closing', start: 8, end: 20 });
    // 两个 Period 各自的初始化资料分别接收。
    assert.equal(status.initializations.length, 2);
    // 没有任何零长度片段被写入。
    const allReceived = status.receivedRanges;
    for (const range of allReceived) assert.ok(range.endSeconds > range.startSeconds);
    const opening = allReceived.filter(r => r.periodId === 'opening');
    const closing = allReceived.filter(r => r.periodId === 'closing');
    assert.equal(opening.reduce((s, r) => s + r.count, 0), 2);
    assert.ok(closing.reduce((s, r) => s + r.count, 0) >= 1);
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('同一地址换内容后重新核对：实际片段身份与当时时间线绑定，旧版本留痕', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-revision-'));
  const { source, catalog, archive } = await makeArchive({ scenario: 'revision', root });
  try {
    archive.select(['hall\u0000camera-r']);
    const first = await archive.tick();
    assert.equal(first.counts.received, 2);
    const slot4Key = 'hall\u0000camera-r\u00004';
    const firstDigest = archive.state.slots[slot4Key].digest;
    assert.equal(archive.state.slots[slot4Key].manifestPublishTime, '2026-10-12T03:00:10Z');

    await new SourceClient(source.base).control({ action: 'advance' });
    const second = await archive.tick();
    // 清单 publishTime 变化触发再核对；同地址 4.m4s 内容已换，摘要不同并保留旧版本留痕。
    const slot4 = archive.state.slots[slot4Key];
    assert.notEqual(slot4.digest, firstDigest);
    assert.equal(slot4.manifestPublishTime, '2026-10-12T03:00:18Z');
    assert.ok(slot4.revisions.some(rev => rev.digest === firstDigest));
    // 新旧两份原件都仍在目录中，可凭各自摘要回读。
    const oldBytes = await catalog.object(firstDigest);
    const newBytes = await catalog.object(slot4.digest);
    assert.ok(!oldBytes.equals(newBytes));
    // 新发布的 8.m4s 也已收妥。
    assert.equal(second.counts.received, 3);
    // 凭据上下文记录了采用时的清单身份与实际响应地址。
    const receipts = await catalog.list();
    const receipt4 = receipts.find(r => r.context?.segmentTime === 4 && r.digest === slot4.digest);
    assert.equal(receipt4.context.manifestPublishTime, '2026-10-12T03:00:18Z');
    assert.equal(receipt4.context.mediaUrl, '/media/r/4.m4s');
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('暂停后重开目录：收妥时段保持、过期时段可核对、状态从磁盘恢复', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-pause-'));
  const source = await startSource({ scenario: 'transition' });
  try {
    const catalog = await new Catalog(join(root, 'catalog')).initialize();
    const archive = await new Archive({ client: new SourceClient(source.base), catalog,
      root: join(root, 'archive'), intervalMs: 60_000 }).initialize();
    archive.select(['hall\u0000camera-a']);
    await archive.tick();
    const paused = await archive.pause();
    assert.equal(paused.running, false);
    assert.ok(paused.pausedAt);
    await archive.close();

    // 模拟资料员暂停后重新打开：同一目录恢复状态。
    const reopenedCatalog = await new Catalog(join(root, 'catalog')).initialize();
    const reopened = await new Archive({ client: new SourceClient(source.base),
      catalog: reopenedCatalog, root: join(root, 'archive'), intervalMs: 60_000 }).initialize();
    const restored = reopened.status();
    assert.equal(restored.counts.received, 3);
    assert.equal(restored.running, false);
    assert.deepEqual(restored.selections, [{ periodId: 'hall', representationId: 'camera-a' }]);

    await new SourceClient(source.base).control({ action: 'advance' });
    const after = await reopened.tick();
    // 已收妥的旧片段仍标记 received；窗口推进后新片段继续收妥。
    assert.ok(after.counts.received >= 3);
    const knownTimes = after.receivedRanges.flatMap(r =>
      Array.from({ length: r.count }, (_, i) => r.from + i * 4));
    assert.ok(knownTimes.includes(0));
    await reopened.close();
  } finally {
    await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('清单声明的未来片段登记为待领，不提前发媒体请求', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-future-'));
  const { source, archive } = await makeArchive({ scenario: 'future', root });
  try {
    archive.select(['hall\u0000camera-f']);
    const status = await archive.tick();
    assert.equal(status.counts.received, 3);
    assert.equal(status.counts.pending, 2);
    const pendingTimes = status.pendingRanges.flatMap(r =>
      Array.from({ length: r.count }, (_, i) => r.from + i * 4));
    assert.deepEqual(pendingTimes, [12, 16]);
    // 待领片段没有产生媒体请求：来源只收到清单、时钟和初始化请求。
    const audit = await new SourceClient(source.base).control({ action: 'inspect' });
    const mediaRequests = audit.requests.filter(item => /\/media\/f\/\d+\.m4s/.test(item.path));
    assert.deepEqual(mediaRequests.map(item => item.path).sort(),
      ['/media/f/0.m4s', '/media/f/4.m4s', '/media/f/8.m4s']);
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('start 后按间隔自动核对，pause 后停止且状态落盘', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-poll-'));
  const { source, archive } = await makeArchive({ scenario: 'ordinary', root, intervalMs: 25 });
  try {
    archive.select(['hall\u0000camera-a']);
    archive.start();
    // 等待至少两个轮询周期自动完成。
    await new Promise(resolve => setTimeout(resolve, 120));
    const paused = await archive.pause();
    assert.equal(paused.running, false);
    assert.equal(archive.status().counts.received, 3);
    const tickBefore = archive.state.lastTickAt;
    await new Promise(resolve => setTimeout(resolve, 80));
    // 暂停后不再产生新的核对时间戳。
    assert.equal(archive.state.lastTickAt, tickBefore);
    const onDisk = JSON.parse(await readFile(join(root, 'archive', 'archive-state.json'), 'utf8'));
    assert.equal(Object.keys(onDisk.slots).length, 3);
    assert.ok(onDisk.pausedAt);
  } finally {
    await archive.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});

test('归档控制通过 HTTP 接口提供，状态可查询', async () => {
  const root = await mkdtemp(join(tmpdir(), 'archive-http-'));
  const source = await startSource({ scenario: 'ordinary' });
  const app = await startApplication({ source: source.base, root, archiveIntervalMs: 60_000 });
  try {
    const select = await fetch(`${app.base}/archive/select`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ representations: ['hall\u0000camera-a'] })
    });
    assert.equal(select.status, 200);
    const tick = await (await fetch(`${app.base}/archive/tick`, { method: 'POST' })).json();
    assert.equal(tick.counts.received, 3);
    const status = await (await fetch(`${app.base}/archive/status`)).json();
    assert.equal(status.selections[0].representationId, 'camera-a');
    const pause = await (await fetch(`${app.base}/archive/pause`, { method: 'POST' })).json();
    assert.equal(pause.running, false);
    // 原有预览与凭据接口不受影响。
    const preview = await (await fetch(`${app.base}/preview`)).json();
    assert.ok(preview.preview.periods[0].representations[0].template);
  } finally {
    await app.close(); await source.close(); await rm(root, { recursive: true, force: true });
  }
});
