// 解释一份 DASH MPD 清单。只做结构提取，不推断缺失资料的业务含义。

function parseAttributes(tag) {
  const attributes = {};
  const pattern = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let match;
  while ((match = pattern.exec(tag))) attributes[match[1]] = match[2] ?? null;
  return attributes;
}

function parseSegmentTimeline(inner) {
  const entries = [];
  for (const match of inner.matchAll(/<S\b([^>]*?)\/>/g)) {
    const attrs = parseAttributes(match[1]);
    entries.push({
      t: attrs.t === undefined ? null : Number(attrs.t),
      d: Number(attrs.d),
      r: attrs.r === undefined ? 0 : Number(attrs.r)
    });
  }
  return entries;
}

function parseTemplate(segmentInner, periodInner) {
  // Representation 内的 SegmentTemplate 优先，缺失时回退到 AdaptationSet 层级。
  const own = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/.exec(segmentInner);
  const inherited = /<SegmentTemplate\b([^>]*?)(?:\/>|>([\s\S]*?)<\/SegmentTemplate>)/.exec(periodInner);
  const tag = own ?? inherited;
  if (!tag) return null;
  const attrs = parseAttributes(tag[1]);
  const timelineInner = tag[2] ?? '';
  return {
    timescale: attrs.timescale === undefined ? 1 : Number(attrs.timescale),
    initialization: attrs.initialization ?? null,
    media: attrs.media ?? null,
    startNumber: attrs.startNumber === undefined ? 1 : Number(attrs.startNumber),
    timeline: /<SegmentTimeline>/.test(timelineInner)
      ? parseSegmentTimeline(timelineInner)
      : null
  };
}

export function parseManifest(bytes) {
  const text = bytes.toString('utf8');
  if (!/<MPD\b/.test(text) || !/<\/MPD>/.test(text)) throw new Error('清单不是完整 MPD');
  const rootTag = /<MPD\b[^>]*>/.exec(text)[0];
  const root = parseAttributes(rootTag);
  const periods = [...text.matchAll(/<Period\b([^>]*)>([\s\S]*?)<\/Period>/g)].map(periodMatch => {
    const periodAttrs = parseAttributes(periodMatch[1]);
    const periodInner = periodMatch[2];
    const representations = [];
    for (const setMatch of periodInner.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)) {
      const setAttrs = parseAttributes(setMatch[1]);
      const setInner = setMatch[2];
      for (const repMatch of setInner.matchAll(/<Representation\b([^>]*)>([\s\S]*?)<\/Representation>|<Representation\b([^>]*)\/>/g)) {
        const repAttrs = parseAttributes(repMatch[1] ?? repMatch[3]);
        const repInner = repMatch[2] ?? '';
        const baseUrl = /<BaseURL>([^<]*)<\/BaseURL>/.exec(repInner)?.[1]
          ?? /<BaseURL>([^<]*)<\/BaseURL>/.exec(setInner)?.[1]
          ?? /<BaseURL>([^<]*)<\/BaseURL>/.exec(periodInner)?.[1]
          ?? null;
        representations.push({
          id: repAttrs.id ?? null,
          bandwidth: repAttrs.bandwidth === undefined ? null : Number(repAttrs.bandwidth),
          mimeType: repAttrs.mimeType ?? setAttrs.mimeType ?? null,
          baseUrl,
          template: parseTemplate(repInner, periodInner)
        });
      }
    }
    return {
      id: periodAttrs.id ?? null,
      start: periodAttrs.start ?? null,
      representations
    };
  });
  return {
    type: root.type ?? null,
    availabilityStartTime: root.availabilityStartTime ?? null,
    publishTime: root.publishTime ?? null,
    minimumUpdatePeriod: root.minimumUpdatePeriod ?? null,
    timeShiftBufferDepth: root.timeShiftBufferDepth ?? null,
    periods
  };
}

// 保留旧入口的预览形状（顶层键不变），嵌套信息随解析器一起增强。
export function decode(bytes) {
  const manifest = parseManifest(bytes);
  return {
    type: manifest.type,
    publishTime: manifest.publishTime,
    periods: manifest.periods.map(period => ({
      id: period.id,
      start: period.start,
      representations: period.representations.map(rep => ({
        id: rep.id,
        bandwidth: rep.bandwidth,
        baseUrl: rep.baseUrl,
        template: rep.template
      }))
    }))
  };
}
