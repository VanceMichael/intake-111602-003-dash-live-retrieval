import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseManifest } from '../src/decode.mjs';
import { buildUrls, declaredSegments, expandTimeline, parseDuration, periodGaps, planManifest } from '../src/timeline.mjs';

async function load(name, phase = 0) {
  const config = JSON.parse(await readFile(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'));
  return parseManifest(Buffer.from(config.phases[phase].routes.find(route => route.path === '/live.mpd').body));
}

test('SegmentTimeline 的固定重复按次数展开，r=-1 受窗口上界约束不会无限生成', () => {
  assert.deepEqual(expandTimeline([{ t: 0, d: 4, r: 2 }]).map(item => item.t), [0, 4, 8]);
  const unbounded = expandTimeline([{ t: 8, d: 4, r: -1 }], { maxGlobalSeconds: 16 });
  assert.deepEqual(unbounded.map(item => item.t), [8, 12, 16]);
  const capped = expandTimeline([{ t: 0, d: 1, r: -1 }], { maxGlobalSeconds: 100, maxEntries: 5 });
  assert.equal(capped.length, 5);
});

test('零持续条目不产生片段，也不补成零长度片段', () => {
  const segments = expandTimeline([{ t: 0, d: 4, r: 1 }, { t: null, d: 0, r: 1 }]);
  assert.deepEqual(segments, [{ t: 0, d: 4 }, { t: 4, d: 4 }]);
  assert.deepEqual(expandTimeline([{ t: 3, d: 0, r: 5 }]), []);
});

test('ISO8601 时长解析', () => {
  assert.equal(parseDuration('PT12S'), 12);
  assert.equal(parseDuration('PT1H30M'), 5400);
  assert.equal(parseDuration('P1DT2H'), 93600);
  assert.equal(parseDuration(null), null);
});

test('可用窗口裁剪：窗口内可领、未来不排请求、滑窗的标过期', async () => {
  const manifest = await load('transition', 1);
  // phase1 时间线为 r=-1：只展开到来源时钟对应的直播边缘，不排未来请求。
  const plan = planManifest(manifest, Date.parse('2026-10-12T01:00:12Z') / 1000);
  assert.deepEqual(plan.available.map(item => item.t), [8, 12]);
  assert.deepEqual(plan.future, []);
  assert.deepEqual(plan.expired, []);
  assert.equal(plan.windowStart, 0);
});

test('窗口滚动后，结束时刻早于窗口起点的片段标为过期', async () => {
  const manifest = await load('transition', 1);
  const plan = planManifest(manifest, Date.parse('2026-10-12T01:00:20Z') / 1000);
  // liveEdge=20，窗口 [8,20]：r=-1 展开 8/12/16/20，起点等于边缘的 20 仍可用。
  assert.deepEqual(plan.expired, []);
  assert.deepEqual(plan.available.map(item => item.t), [8, 12, 16, 20]);
  assert.deepEqual(plan.future, []);
});

test('固定次数声明的片段按窗口分类：未到时为未来、滑出为过期', async () => {
  const manifest = await load('ordinary');
  // phase0 时间线 r=2：自身加两次重复，共声明 t=0/4/8 三个片段。
  const plan = planManifest(manifest, Date.parse('2026-10-12T01:00:12Z') / 1000);
  assert.deepEqual(plan.available.map(item => item.t), [0, 4, 8]);
  assert.deepEqual(plan.future, []);
  const later = planManifest(manifest, Date.parse('2026-10-12T01:00:20Z') / 1000);
  assert.deepEqual(later.expired.map(item => item.t), [0, 4]);
  assert.deepEqual(later.available.map(item => item.t), [8]);
});

test('固定次数延伸到未来的声明保留为未来片段，不提前发请求', async () => {
  const manifest = await load('future');
  // r=4 声明 t=0..16；时钟只到 8 秒，12/16 尚未发布。
  const plan = planManifest(manifest, Date.parse('2026-10-12T01:00:08Z') / 1000);
  assert.deepEqual(plan.available.map(item => item.t), [0, 4, 8]);
  assert.deepEqual(plan.future.map(item => item.t), [12, 16]);
  assert.deepEqual(plan.expired, []);
});

test('Period 之间的真实空档被识别，紧密衔接不算空档', async () => {
  const gapConfig = JSON.parse(await readFile(new URL('../fixtures/gap.json', import.meta.url), 'utf8'));
  const gapMpd = parseManifest(Buffer.from(gapConfig.phases[0].routes[0].body));
  const gaps = periodGaps(gapMpd);
  assert.equal(gaps.length, 1);
  assert.deepEqual({ after: gaps[0].afterPeriod, before: gaps[0].beforePeriod,
    start: gaps[0].startSeconds, end: gaps[0].endSeconds },
    { after: 'opening', before: 'closing', start: 8, end: 20 });

  const ordinary = await load('ordinary');
  assert.deepEqual(periodGaps(ordinary), []);
});

test('声明片段按 Period 与 Representation 展开并换算秒级时间', async () => {
  const manifest = await load('gap');
  // opening 为固定声明（本地 t=0/4）；closing 起点 20s，r=-1 按全局边缘 30
  // 展开本地 t=0/4/8（对应全局 20/24/28 秒）。
  const segments = declaredSegments(manifest, { maxTimeSeconds: 30 });
  assert.equal(segments.length, 5);
  const closing = segments.filter(item => item.periodId === 'closing');
  assert.deepEqual(closing.map(item => ({ t: item.t, start: item.startSeconds, end: item.endSeconds })),
    [{ t: 0, start: 20, end: 24 }, { t: 4, start: 24, end: 28 }, { t: 8, start: 28, end: 32 }]);
  const opening = segments.filter(item => item.periodId === 'opening');
  assert.deepEqual(opening.map(item => item.t), [0, 4]);
});

test('片段地址由 BaseURL 与模板计算，$Time$ 与初始化模板分别替换', async () => {
  const manifest = await load('ordinary');
  const urls = buildUrls(manifest, { periodId: 'hall', representationId: 'camera-a', t: 4 });
  assert.equal(urls.mediaUrl, '/media/a/4.m4s');
  assert.equal(urls.initializationUrl, '/media/a/init.mp4');
});

test('解码器提取时间线与模板结构，顶层预览键保持不变', async () => {
  const manifest = await load('cameras');
  const rep = manifest.periods[0].representations[0];
  assert.equal(rep.id, 'camera-a');
  assert.equal(rep.baseUrl, '/media/a/');
  assert.equal(rep.template.media, '$Time$.m4s');
  assert.equal(rep.template.initialization, 'init.mp4');
  assert.deepEqual(rep.template.timeline, [{ t: 0, d: 4, r: 2 }]);
  assert.equal(manifest.periods[0].representations[1].id, 'camera-b');
});
