export function decode(bytes) {
  const text = bytes.toString('utf8');
  if (!/<MPD\b/.test(text) || !/<\/MPD>/.test(text)) throw new Error('清单不是完整 MPD');
  const attribute = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const root = /<MPD\b[^>]*>/.exec(text)[0];
  const periods = [...text.matchAll(/<Period\b([^>]*)>([\s\S]*?)<\/Period>/g)].map(match => ({
    id: attribute(match[1], 'id'), start: attribute(match[1], 'start'),
    representations: [...match[2].matchAll(/<Representation\b([^>]*)>/g)].map(item => ({ id: attribute(item[1], 'id'), bandwidth: Number(attribute(item[1], 'bandwidth')) }))
  }));
  return { type: attribute(root, 'type'), publishTime: attribute(root, 'publishTime'), periods };
}
