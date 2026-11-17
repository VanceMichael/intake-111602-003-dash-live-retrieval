// DASH 时间线处理：SegmentTimeline 展开、可用窗口裁剪、Period 空档、地址构造。
// 纯函数模块，不发起任何网络请求；窗口之外不凭空制造片段，空档不补零长度。

const UNIT_SECONDS = { S: 1, M: 60, H: 3600 };

export function parseDuration(value) {
  if (value === null || value === undefined) return null;
  // ISO 8601 时长：P[nD]T[nH][nM][nS]，各分量均可省略但至少带一个时间分量。
  if (!/^P(?:\d+(?:\.\d+)?D)?(?:T(?:\d+(?:\.\d+)?H)?(?:\d+(?:\.\d+)?M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value)) {
    return null;
  }
  const units = [...value.matchAll(/(\d+(?:\.\d+)?)([HMSD])/g)];
  if (!units.length) return null;
  return units.reduce((sum, [, amount, unit]) => {
    const factor = unit === 'D' ? 86400 : UNIT_SECONDS[unit];
    return sum + Number(amount) * factor;
  }, 0);
}

export function parseTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms / 1000;
}

// 展开一条 SegmentTimeline，返回 { t, d } 序列（t 为时间线本地时间单位）。
// r 为重复次数（不含自身），r="-1" 表示重复到窗口边界为止，由 maxGlobalSeconds
// 与周期起点、timescale 共同限定，绝不产生无限序列。
export function expandTimeline(entries, { maxGlobalSeconds = null, periodStartSeconds = 0,
  timescale = 1, maxEntries = 10000 } = {}) {
  const segments = [];
  let cursor = null;
  for (const entry of entries) {
    if (entry.t !== null) cursor = entry.t;
    if (cursor === null || !Number.isFinite(cursor)) cursor = 0;
    const repeats = entry.r < 0 ? Infinity : entry.r;
    for (let index = 0; index <= repeats; index += 1) {
      if (segments.length >= maxEntries) return segments;
      if (entry.d > 0) {
        // cursor 是相对 Period 起点的本地时间单位；换算成相对 AST 的全局秒后，
        // 再与直播边缘比较，起点严格越过边界才停止。
        const startSeconds = periodStartSeconds + cursor / timescale;
        if (maxGlobalSeconds !== null && startSeconds > maxGlobalSeconds) return segments;
        segments.push({ t: cursor, d: entry.d });
      }
      // d 为 0 的条目本身不构成片段，也不补零长度，仅推进游标。
      cursor += entry.d;
    }
  }
  return segments;
}

// 取清单声明的全部候选片段。固定次数的条目（r>=0）即使指向未来也保留，
// 以便暂停恢复时区分“尚未发布”与“缺失”；r=-1 只展开到 maxTimeSeconds
// （相对 availabilityStartTime 的秒级直播边缘），因此绝不会排出无限多的未来请求。
export function declaredSegments(manifest, { maxTimeSeconds = null, maxEntries = 10000 } = {}) {
  const result = [];
  for (const period of manifest.periods) {
    const parsedStart = parseDuration(period.start);
    const baseStart = parsedStart === null ? 0 : parsedStart;
    for (const rep of period.representations) {
      if (!rep.template?.timeline) continue;
      const scale = rep.template.timescale || 1;
      const hasOpenEnd = rep.template.timeline.some(entry => entry.r < 0);
      // r=-1 必须有界：优先用直播边缘；未提供边界时把边界设为首个片段起点，
      // 使展开严格只保留首个已知点，任何调用路径都不会得到无限或上万条未来序列。
      const firstLocal = rep.template.timeline.find(entry => entry.t !== null)?.t ?? 0;
      const bound = !hasOpenEnd ? null
        : (maxTimeSeconds ?? baseStart + firstLocal / scale);
      for (const segment of expandTimeline(rep.template.timeline,
        { maxGlobalSeconds: bound, periodStartSeconds: baseStart, timescale: scale, maxEntries })) {
        result.push({
          periodId: period.id,
          representationId: rep.id,
          t: segment.t,
          d: segment.d,
          startSeconds: baseStart + segment.t / scale,
          endSeconds: baseStart + (segment.t + segment.d) / scale
        });
      }
    }
  }
  return result;
}

// 依据来源时钟与 timeShiftBufferDepth 计算当前真正可领取的片段。
// 尚未到发布时刻的片段留在“未来”，不发请求；滑出窗口的片段标为过期。
export function planManifest(manifest, nowSeconds) {
  const start = parseTimestamp(manifest.availabilityStartTime) ?? nowSeconds;
  const bufferDepth = parseDuration(manifest.timeShiftBufferDepth);
  const liveEdge = nowSeconds - start;
  const windowStart = bufferDepth === null ? null : liveEdge - bufferDepth;
  const available = [];
  const future = [];
  const expired = [];
  // 固定次数（r>=0）的未来声明完整保留以便分类；r=-1 的展开在
  // declaredSegments 内部自动以直播边缘为界，不会无限生成。
  const all = declaredSegments(manifest, { maxTimeSeconds: liveEdge });
  for (const segment of all) {
    if (segment.startSeconds > liveEdge) future.push(segment);
    else if (windowStart !== null && segment.endSeconds <= windowStart) expired.push(segment);
    else available.push(segment);
  }
  return { liveEdge, windowStart, available, future, expired };
}

// Period 之间的真实空档：上一个 Period 最后一个片段结束之后、下一个 Period
// 首个片段开始之前。零或负长度的衔接不是空档，绝不补成零长度片段。
export function periodGaps(manifest) {
  const gaps = [];
  const boundaries = manifest.periods.map(period => {
    const start = parseDuration(period.start);
    const baseStart = start === null ? 0 : start;
    // 空档只看清单已声明的片段；r=-1 取首个已知点，不向未来无限延伸。
    const lastEnd = declaredSegments(manifest)
      .filter(segment => segment.periodId === period.id)
      .reduce((max, segment) => Math.max(max, segment.endSeconds), baseStart);
    return { periodId: period.id, start: baseStart, lastEnd };
  }).sort((a, b) => a.start - b.start);
  for (let i = 1; i < boundaries.length; i += 1) {
    const gapStart = boundaries[i - 1].lastEnd;
    const gapEnd = boundaries[i].start;
    if (gapEnd > gapStart) gaps.push({ afterPeriod: boundaries[i - 1].periodId, beforePeriod: boundaries[i].periodId,
      startSeconds: gapStart, endSeconds: gapEnd });
  }
  return gaps;
}

function applyTemplate(pattern, rep, segment, index) {
  const scale = rep.template.timescale || 1;
  return pattern
    .replaceAll('$Time$', String(segment.t))
    .replaceAll('$Number$', String(rep.template.startNumber + index))
    .replaceAll('$RepresentationID$', encodeURIComponent(rep.id))
    .replaceAll('$Bandwidth$', String(rep.bandwidth ?? ''));
}

// 由 BaseURL + SegmentTemplate 计算初始化片段与媒体片段地址。
export function buildUrls(manifest, segmentLike) {
  const period = manifest.periods.find(item => item.id === segmentLike.periodId);
  const rep = period?.representations.find(item => item.id === segmentLike.representationId);
  if (!rep?.template) throw new Error('该 Representation 缺少 SegmentTemplate');
  const base = rep.baseUrl ?? '';
  // 用有界展开计算序号，r=-1 不会触发无限遍历。
  const index = rep.template.timeline
    ? declaredSegments(manifest).findIndex(item =>
      item.periodId === segmentLike.periodId
      && item.representationId === segmentLike.representationId
      && item.t === segmentLike.t)
    : 0;
  const media = applyTemplate(rep.template.media, rep, segmentLike, index < 0 ? 0 : index);
  const initialization = rep.template.initialization
    ? applyTemplate(rep.template.initialization, rep, segmentLike, index < 0 ? 0 : index)
    : null;
  return {
    mediaUrl: new URL(base + media, 'http://manifest.local/live.mpd').pathname,
    initializationUrl: initialization === null ? null
      : new URL(base + initialization, 'http://manifest.local/live.mpd').pathname
  };
}
