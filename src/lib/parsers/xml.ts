// A tiny, forgiving XML parser. MPD manifests must be parsed in the service worker and in
// workers where DOMParser does not exist, so we ship our own (~no dependencies).

export interface XmlNode {
  name: string;
  /** Local name without namespace prefix. */
  local: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
  parent?: XmlNode;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

const localName = (n: string) => {
  const i = n.indexOf(':');
  return i >= 0 ? n.slice(i + 1) : n;
};

export function parseXml(src: string): XmlNode {
  const root: XmlNode = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  let cur = root;
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) {
      cur.text += decodeEntities(src.slice(i));
      break;
    }
    if (lt > i) cur.text += decodeEntities(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9);
      cur.text += src.slice(lt + 9, end < 0 ? n : end);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }
    // Find the closing '>' while respecting quoted attribute values.
    let j = lt + 1;
    let quote = '';
    while (j < n) {
      const c = src[j];
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const inner = src.slice(lt + 1, j);
    i = j + 1;
    if (inner[0] === '/') {
      const name = inner.slice(1).trim();
      // Pop to the matching element (tolerates malformed nesting).
      let p: XmlNode | undefined = cur;
      while (p && p.name !== name) p = p.parent;
      if (p && p.parent) cur = p.parent;
      continue;
    }
    const selfClose = inner.endsWith('/');
    const body = selfClose ? inner.slice(0, -1) : inner;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const attrs: Record<string, string> = {};
    if (sp >= 0) {
      const rest = body.slice(sp);
      attrRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(rest))) {
        attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
      }
    }
    const node: XmlNode = { name, local: localName(name), attrs, children: [], text: '', parent: cur };
    cur.children.push(node);
    if (!selfClose) cur = node;
  }
  return root;
}

export const childrenOf = (node: XmlNode | undefined, local: string) =>
  node ? node.children.filter((c) => c.local === local) : [];

export const childOf = (node: XmlNode | undefined, local: string) => node?.children.find((c) => c.local === local);

export function findFirst(node: XmlNode, local: string): XmlNode | undefined {
  if (node.local === local) return node;
  for (const c of node.children) {
    const r = findFirst(c, local);
    if (r) return r;
  }
  return undefined;
}
