import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Catalog } from './catalog.mjs';
import { decode } from './decode.mjs';
import { SourceClient } from './transport.mjs';
import { Archive } from './archive.mjs';
import { profile } from './profile.mjs';

export async function previewOne(base, path = profile.previewPath) {
  const result = await new SourceClient(base).request(path);
  if (result.status !== 200) throw new Error(`来源响应：${result.status}`);
  return { ...result, preview: decode(result.bytes, result.headers) };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export async function startApplication({ source, root, port = 0,
  archiveIntervalMs = Number(process.env.ARCHIVE_INTERVAL_MS || 1000),
  archiveHeaders = {} } = {}) {
  const catalog = await new Catalog(root).initialize();
  const archive = await new Archive({
    client: new SourceClient(source), catalog, root: `${root}/archive`,
    intervalMs: archiveIntervalMs, headers: archiveHeaders
  }).initialize();
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/health') return response.end(JSON.stringify({ ready: true, product: profile.name }));
      if (request.method === 'GET' && url.pathname === '/preview') {
        const result = await previewOne(source, url.searchParams.get('path') || profile.previewPath);
        return response.end(JSON.stringify({ source: result.url, preview: result.preview }));
      }
      if (request.method === 'POST' && url.pathname === '/receipts') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks));
        const result = await previewOne(source, input.path || profile.previewPath);
        const receipt = await catalog.accept({ source: result.url, bytes: result.bytes,
          mediaType: result.headers['content-type'], preview: result.preview });
        response.statusCode = 201;
        return response.end(JSON.stringify(receipt));
      }
      if (request.method === 'GET' && url.pathname === '/receipts') return response.end(JSON.stringify(await catalog.list()));
      if (request.method === 'POST' && url.pathname === '/archive/select') {
        const input = await readJson(request);
        const selections = archive.select(input.representations);
        await archive.persist();
        return response.end(JSON.stringify({ selections: archive.status().selections, raw: selections }));
      }
      if (request.method === 'POST' && url.pathname === '/archive/start') {
        return response.end(JSON.stringify(archive.start()));
      }
      if (request.method === 'POST' && url.pathname === '/archive/pause') {
        return response.end(JSON.stringify(await archive.pause()));
      }
      if (request.method === 'POST' && url.pathname === '/archive/tick') {
        return response.end(JSON.stringify(await archive.tick()));
      }
      if (request.method === 'GET' && url.pathname === '/archive/status') {
        return response.end(JSON.stringify(archive.status()));
      }
      if (request.method === 'GET' && url.pathname.startsWith('/objects/')) {
        response.setHeader('content-type', 'application/octet-stream');
        return response.end(await catalog.object(url.pathname.split('/').at(-1)));
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ error: '没有此操作' }));
    } catch (error) {
      response.statusCode = 422;
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, catalog, archive,
    close: async () => { await archive.close(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = await startApplication({ source: process.env.SOURCE_URL || 'http://127.0.0.1:4310',
    root: process.env.DATA_DIR || './var', port: Number(process.env.PORT || 4320) });
  process.stdout.write(`资料查看服务已启动：${app.base}\n`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
