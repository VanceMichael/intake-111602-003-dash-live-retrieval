import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSource } from '../source/service.mjs';
import { startApplication } from '../src/app.mjs';

const directory = await mkdtemp(join(tmpdir(), 'intake-'));
const source = await startSource();
const app = await startApplication({ source: source.base, root: directory, archiveIntervalMs: 60_000 });
try {
  const preview = await fetch(`${app.base}/preview`).then(response => response.json());
  process.stdout.write(`当前资料预览\n${JSON.stringify(preview, null, 2)}\n`);

  // 选择要归档的 Representation，启动一轮持续领取。
  const selected = await fetch(`${app.base}/archive/select`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ representations: ['hall\u0000camera-a'] })
  }).then(response => response.json());
  process.stdout.write(`\n已选择机位：${selected.selections.map(item => item.representationId).join(', ')}\n`);

  const status = await fetch(`${app.base}/archive/tick`, { method: 'POST' }).then(response => response.json());
  process.stdout.write(`\n归档核对结果：\n`);
  process.stdout.write(`  收妥片段：${status.counts.received}，待领：${status.counts.pending}，过期：${status.counts.expired}\n`);
  process.stdout.write(`  初始化资料：${status.initializations.map(item => item.url).join(', ')}\n`);
  for (const range of status.receivedRanges) {
    process.stdout.write(`  收妥时段：Period=${range.periodId} 机位=${range.representationId} `
      + `t=${range.from}..${range.to}（${range.count} 个片段）\n`);
  }

  const saved = await fetch(`${app.base}/receipts`, { method: 'POST', body: '{}' }).then(response => response.json());
  const body = await fetch(`${app.base}/objects/${saved.digest}`).then(response => response.arrayBuffer());
  if (body.byteLength !== saved.bytes) throw new Error('原始资料长度不符');
  process.stdout.write(`\n原件已接收：${saved.digest}，${saved.bytes} 字节\n`);
  process.stdout.write(`归档凭据与原件均位于 ${directory}，暂停后重开可凭状态文件继续核对。\n`);
} finally {
  await app.close();
  await source.close();
  await rm(directory, { recursive: true, force: true });
}
