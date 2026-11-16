export function dispatch({ url, phase }) {
  const match = /^\/media\/a\/(\d+)\.m4s$/.exec(url.pathname);
  if (match) {
    const time = Number(match[1]);
    if (phase && time < 8) return { status: 410, json: { error: '媒体片段已离开可用窗口', time } };
    if (time > (phase ? 16 : 8)) return { status: 404, json: { error: '片段尚不可用', time } };
  }
  if (url.pathname === '/clock') return { json: { now: phase ? '2026-10-12T01:00:20Z' : '2026-10-12T01:00:12Z' } };
  return null;
}
