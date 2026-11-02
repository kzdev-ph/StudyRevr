import os from 'node:os';

// PUBLIC_URL: the address links in emails point at (for example a Cloudflare tunnel). A plain http(s) address only;
// anything else is ignored with a warning that never repeats the value (it could hold a password).
export function parsePublicUrl(raw, warn = console.warn) {
  const text = String(raw || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  const ok = url && (url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password && !url.search && !url.hash;
  if (!ok) {
    warn('[config] PUBLIC_URL ignored: use a plain http:// or https:// address such as https://example.trycloudflare.com');
    return '';
  }
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

// How likely an address is the one phones on the Wi-Fi reach: home and school routers hand out 192.168.x.x, then 10.x.x.x;
// 172.16-31.x.x is often a virtual adapter (WSL, Hyper-V, Docker); anything else comes last.
const lanRank = (address) => {
  if (/^192\.168\./.test(address)) return 0;
  if (/^10\./.test(address)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 2;
  return 3;
};

// Used when PUBLIC_URL is not set: this machine's most likely LAN address (see lanRank; the first of equals). Never built
// from the Host header, which a caller controls and could point a reset link at their own site.
export function fallbackBase(port, interfaces = os.networkInterfaces()) {
  const lan = Object.values(interfaces).flat().filter((a) => a && a.family === 'IPv4' && !a.internal);
  const best = lan.reduce((top, a) => (top && lanRank(top.address) <= lanRank(a.address) ? top : a), null);
  return `http://${best ? best.address : 'localhost'}:${port}`;
}

// kind: 'verify' | 'reset'. The token sits after the # so it never reaches server logs or Referer headers.
export const linkTo = (base, kind, token) => `${base}/#/${kind}/${token}`;
