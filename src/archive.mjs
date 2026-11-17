import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest } from './decode.mjs';
import { buildUrls, parseTimestamp, periodGaps, planManifest } from './timeline.mjs';

const STATE_FILE = 'archive-state.json';

// 把片段实际身份（来源地址、摘要、采用时间）与当时采用的时间线身份
// （清单 publishTime、Period/Representation、SegmentTemplate 时间戳）绑定。
function adoptionContext({ manifestUrl, manifest, slot, urls, result }) {
  return {
    manifestUrl,
    manifestPublishTime: manifest.publishTime,
    periodId: slot.periodId,
    representationId: slot.representationId,
    segmentTime: slot.t,
    segmentStartSeconds: slot.startSeconds,
    segmentEndSeconds: slot.endSeconds,
    mediaUrl: urls.mediaUrl,
    responseUrl: result.url,
    responseStatus: result.status
  };
}

export class Archive {
  constructor({ client, catalog, root, manifestPath = '/live.mpd', clockPath = '/clock',
    intervalMs = 1000, headers = {} } = {}) {
    if (!client || !catalog) throw new TypeError('归档器需要来源客户端与原件目录');
    this.client = client;
    this.catalog = catalog;
    this.root = root;
    this.manifestPath = manifestPath;
    this.clockPath = clockPath;
    this.intervalMs = intervalMs;
    this.headers = headers;
    this.state = null;
    this.timer = null;
    this.running = false;
    this.ticking = Promise.resolve();
    this.tickInFlight = null;
  }

  async initialize() {
    await mkdir(this.root, { recursive: true });
    const path = join(this.root, STATE_FILE);
    try {
      this.state = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = {
        sessionId: randomUUID(),
        manifestPath: this.manifestPath,
        selections: [],
        startedAt: null,
        pausedAt: null,
        lastTickAt: null,
        lastManifest: { url: null, publishTime: null, digest: null },
        slots: {},
        initializations: {},
        gaps: [],
        errors: {}
      };
    }
    return this;
  }

  async atomic(path, bytes) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  }

  async persist() {
    await this.atomic(join(this.root, STATE_FILE),
      Buffer.from(JSON.stringify(this.state, null, 2)));
  }

  select(representationIds) {
    if (!Array.isArray(representationIds) || representationIds.length === 0) {
      throw new Error('至少选择一个 Representation');
    }
    const unique = [...new Set(representationIds.map(String))];
    this.state.selections = unique;
    this.state.pausedAt = null;
    return this.state.selections;
  }

  start() {
    if (this.state.selections.length === 0) throw new Error('尚未选择 Representation');
    this.state.startedAt ??= new Date().toISOString();
    this.state.pausedAt = null;
    this.running = true;
    this.schedule();
    return { running: true, intervalMs: this.intervalMs };
  }

  pause() {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.state.pausedAt = new Date().toISOString();
    return this.ticking.then(() => this.persist()).then(() => ({ running: false, pausedAt: this.state.pausedAt }));
  }

  async close() {
    await this.pause();
  }

  schedule() {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.ticking = this.tick().catch(error => {
        this.state.errors.__scheduler = { at: new Date().toISOString(), message: error.message };
      }).finally(() => {
        if (this.running) this.schedule();
      });
    }, this.intervalMs);
    this.timer.unref?.();
  }

  // 手动触发一轮核对（测试与暂停恢复场景使用）。同一时刻只允许一轮核对。
  async tick() {
    if (this.tickInFlight) return this.tickInFlight;
    this.tickInFlight = this.runTick().finally(() => { this.tickInFlight = null; });
    return this.tickInFlight;
  }

  async runTick() {
    const manifestResult = await this.client.request(this.manifestPath, { headers: this.headers });
    if (manifestResult.status !== 200) throw new Error(`清单响应：${manifestResult.status}`);
    const manifest = parseManifest(manifestResult.bytes);
    const nowSeconds = await this.fetchClock(manifest);
    this.state.lastTickAt = new Date().toISOString();
    this.state.lastManifest = {
      url: manifestResult.url,
      publishTime: manifest.publishTime,
      digest: createHash('sha256').update(manifestResult.bytes).digest('hex')
    };
    this.state.gaps = periodGaps(manifest);
    const plan = planManifest(manifest, nowSeconds);
    const known = new Set(manifest.periods.flatMap(period =>
      period.representations.map(rep => `${period.id}\u0000${rep.id}`)));
    await Promise.allSettled(this.state.selections.map(async key => {
      const [periodId, representationId] = key.split('\u0000');
      if (!known.has(key)) {
        this.state.errors[key] = { at: new Date().toISOString(), message: '清单中已找不到该 Representation' };
        return;
      }
      try {
        await this.syncRepresentation({ manifest, manifestUrl: manifestResult.url, plan, periodId, representationId });
        delete this.state.errors[key];
      } catch (error) {
        // 一个机位暂时失联不影响其他已授权机位：错误只记录在该机位名下。
        this.state.errors[key] = { at: new Date().toISOString(), message: error.message };
      }
    }));
    this.reconcileExpired(plan);
    await this.persist();
    return this.status();
  }

  async fetchClock(manifest) {
    try {
      const clock = await this.client.request(this.clockPath, { headers: this.headers });
      if (clock.status === 200) {
        const value = parseTimestamp(JSON.parse(clock.bytes.toString('utf8')).now);
        if (value !== null) return value;
      }
    } catch {
      // 来源暂时不提供受控时钟时，回退到本机时钟。
    }
    return parseTimestamp(manifest.publishTime) ?? Date.now() / 1000;
  }

  async syncRepresentation({ manifest, manifestUrl, plan, periodId, representationId }) {
    const key = `${periodId}\u0000${representationId}`;
    await this.ensureInitialization({ manifest, manifestUrl, periodId, representationId, key });
    const belongs = slot => slot.periodId === periodId && slot.representationId === representationId;
    // 窗口内的片段实际领取；清单已声明但尚未发布的片段只登记待领，不发媒体请求。
    for (const slot of plan.available.filter(belongs)) {
      await this.handleSlot({ manifest, manifestUrl, slot });
    }
    for (const slot of plan.future.filter(belongs)) {
      const slotKey = this.slotKey(slot);
      if (this.state.slots[slotKey]?.state === 'received') continue;
      this.state.slots[slotKey] = { ...slot, state: 'pending',
        urls: buildUrls(manifest, slot), checkedAt: new Date().toISOString(),
        manifestPublishTime: manifest.publishTime,
        attempts: (this.state.slots[slotKey]?.attempts ?? 0) + 1, note: '清单已声明，尚未到发布时刻' };
    }
    // 已滑出窗口且从未收妥的片段登记为过期，资料员可据此知道哪些时段拿不到。
    for (const slot of plan.expired.filter(belongs)) {
      const slotKey = this.slotKey(slot);
      if (this.state.slots[slotKey]?.state === 'received') continue;
      this.state.slots[slotKey] = { ...slot, state: 'expired',
        urls: buildUrls(manifest, slot), markedAt: new Date().toISOString(),
        manifestPublishTime: manifest.publishTime,
        attempts: (this.state.slots[slotKey]?.attempts ?? 0) + 1, note: '已离开来源可用窗口' };
    }
  }

  async ensureInitialization({ manifest, manifestUrl, periodId, representationId, key }) {
    const period = manifest.periods.find(item => item.id === periodId);
    const rep = period?.representations.find(item => item.id === representationId);
    if (!rep?.template?.initialization) return;
    const urls = buildUrls(manifest, { periodId, representationId, t: 0 });
    const initKey = `${key}\u0000${urls.initializationUrl}`;
    const held = this.state.initializations[initKey];
    // 地址未变则不重复领取；同一地址换内容时靠摘要差异重新接收。
    if (held?.manifestPublishTime === manifest.publishTime) return;
    const result = await this.client.request(urls.initializationUrl, { headers: this.headers });
    if (result.status !== 200) throw new Error(`初始化片段响应：${result.status}`);
    const receipt = await this.catalog.accept({
      source: result.url, bytes: result.bytes, mediaType: result.headers['content-type'] ?? null,
      preview: null,
      context: { kind: 'initialization', manifestUrl, manifestPublishTime: manifest.publishTime,
        periodId, representationId, initializationUrl: urls.initializationUrl,
        responseUrl: result.url, responseStatus: result.status }
    });
    this.state.initializations[initKey] = {
      url: urls.initializationUrl, digest: receipt.digest,
      manifestPublishTime: manifest.publishTime, receivedAt: receipt.receivedAt, receiptId: receipt.id
    };
  }

  slotKey(slot) {
    return `${slot.periodId}\u0000${slot.representationId}\u0000${slot.t}`;
  }

  async handleSlot({ manifest, manifestUrl, slot }) {
    const key = this.slotKey(slot);
    const held = this.state.slots[key];
    const urls = buildUrls(manifest, slot);
    // 已收妥且时间线身份未变（清单发布时间与地址都一致）则不重复领取；
    // 清单刷新改地址或同一地址换内容时，重新核对实际片段身份。
    if (held?.state === 'received'
      && held.manifestPublishTime === manifest.publishTime
      && held.urls?.mediaUrl === urls.mediaUrl) return;
    const result = await this.client.request(urls.mediaUrl, { headers: this.headers });
    // 已收妥的片段即使来源窗口里已 410，原件仍在本地，保持“收妥”，只记录刷新结果。
    if (result.status === 410 && held?.state === 'received') {
      held.refresh = { status: 410, at: new Date().toISOString() };
      held.manifestPublishTime = manifest.publishTime;
      held.urls = urls;
      this.state.slots[key] = held;
      return;
    }
    if (result.status === 410) {
      this.state.slots[key] = { ...slot, state: 'expired', urls,
        markedAt: new Date().toISOString(), manifestPublishTime: manifest.publishTime, attempts: (held?.attempts ?? 0) + 1 };
      return;
    }
    if (result.status === 404) {
      // 尚不可用不是缺失：保留待领状态，下一轮清单刷新后再核对。
      this.state.slots[key] = { ...slot, state: 'pending', urls,
        checkedAt: new Date().toISOString(), manifestPublishTime: manifest.publishTime, attempts: (held?.attempts ?? 0) + 1 };
      return;
    }
    if (result.status !== 200) throw new Error(`媒体片段响应：${result.status}`);
    const receipt = await this.catalog.accept({
      source: result.url, bytes: result.bytes,
      mediaType: result.headers['content-type'] ?? null, preview: null,
      context: adoptionContext({ manifestUrl, manifest, slot, urls, result })
    });
    const revisions = held?.revisions ?? [];
    if (held?.digest && held.digest !== receipt.digest) revisions.push({ digest: held.digest, source: held.source, until: new Date().toISOString() });
    this.state.slots[key] = {
      ...slot, state: 'received', urls,
      digest: receipt.digest, source: result.url, receiptId: receipt.id,
      manifestPublishTime: manifest.publishTime, receivedAt: receipt.receivedAt,
      refresh: held?.state === 'received' ? { status: 200, at: new Date().toISOString() } : (held?.refresh ?? null),
      revisions
    };
  }

  reconcileExpired(plan) {
    const expiredKeys = new Set(plan.expired.map(slot => this.slotKey(slot)));
    for (const [key, slot] of Object.entries(this.state.slots)) {
      if (slot.state === 'received') continue;
      if (expiredKeys.has(key) && slot.state !== 'expired') {
        slot.state = 'expired';
        slot.markedAt = new Date().toISOString();
      }
    }
  }

  // 资料员视角：哪些时段确实收妥、哪些已过期拿不到、哪些仍在等待。
  status() {
    const slots = Object.values(this.state.slots);
    const byState = state => slots.filter(slot => slot.state === state)
      .sort((a, b) => a.startSeconds - b.startSeconds);
    const mergeRanges = items => {
      const ranges = [];
      for (const slot of items) {
        const last = ranges.at(-1);
        if (last && last.periodId === slot.periodId && last.representationId === slot.representationId
          && last.endSeconds === slot.startSeconds) {
          last.endSeconds = slot.endSeconds;
          last.to = slot.t;
          last.count += 1;
        } else {
          ranges.push({ periodId: slot.periodId, representationId: slot.representationId,
            from: slot.t, to: slot.t, startSeconds: slot.startSeconds,
            endSeconds: slot.endSeconds, count: 1 });
        }
      }
      return ranges;
    };
    return {
      sessionId: this.state.sessionId,
      selections: this.state.selections.map(key => {
        const [periodId, representationId] = key.split('\u0000');
        return { periodId, representationId };
      }),
      running: this.running,
      startedAt: this.state.startedAt,
      pausedAt: this.state.pausedAt,
      lastTickAt: this.state.lastTickAt,
      lastManifest: this.state.lastManifest,
      receivedRanges: mergeRanges(byState('received')),
      expiredRanges: mergeRanges(byState('expired')),
      pendingRanges: mergeRanges(byState('pending')),
      gaps: this.state.gaps,
      initializations: Object.values(this.state.initializations),
      errors: this.state.errors,
      counts: {
        received: byState('received').length,
        expired: byState('expired').length,
        pending: byState('pending').length
      }
    };
  }

  async reset() {
    await this.pause();
    await rm(join(this.root, STATE_FILE), { force: true });
    await this.initialize();
  }
}
