// SOCKS5 / SOCKS4a egress — the transport Tor actually speaks.
//
// Why this file exists: undici's ProxyAgent (which ships with Node) implements HTTP
// CONNECT proxies ONLY. Pointing it at `socks5://127.0.0.1:9050` does not proxy the
// request through Tor — it fails, and a collector that then falls back to direct egress
// has just sent a .onion-adjacent query from the analyst's real address. That is not a
// missing feature, it is an OPSEC failure. So we speak SOCKS ourselves.
//
// No new dependency: SOCKS5 (RFC 1928) is a short binary handshake over a TCP socket,
// and undici lets us supply a custom `connect` that returns an already-connected socket.
//
// Two properties matter more than speed here:
//   1. REMOTE DNS. The destination hostname is sent to the proxy as a name (ATYP 0x03),
//      never resolved locally. A local lookup for a target's host leaks the target to
//      the analyst's resolver and ISP — and .onion cannot be resolved locally at all.
//   2. FAIL CLOSED. Every failure path throws. Nothing in this module silently returns
//      a direct socket.

export interface SocksProxy {
  version: 4 | 5;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

const SOCKS_SCHEMES = /^socks(4a?|5h?)?:$/i;

/** Is this proxy URL a SOCKS proxy (as opposed to an HTTP CONNECT proxy)? */
export function isSocksUrl(url: string): boolean {
  try { return SOCKS_SCHEMES.test(new URL(url).protocol); } catch { return false; }
}

/**
 * Parse a proxy URL into a SOCKS descriptor. Returns null for non-SOCKS URLs.
 * socks4 → version 4 (with the 4a hostname extension, which we always use);
 * socks / socks5 / socks5h → version 5. We treat socks5 as socks5h: names are always
 * resolved at the proxy, because the alternative leaks.
 */
export function parseSocks(url: string): SocksProxy | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!SOCKS_SCHEMES.test(u.protocol)) return null;
  const version: 4 | 5 = /^socks4/i.test(u.protocol) ? 4 : 5;
  const host = u.hostname;
  if (!host) return null;
  const port = Number(u.port) || 1080;
  return {
    version,
    host,
    port,
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
}

// ---- onion addressing --------------------------------------------------------
// Lives here rather than in lib/darkweb because it is a TRANSPORT fact: ".onion means
// this must go through SOCKS". The network layer needs it, and must not depend on the
// darkweb collectors to know it.

export type OnionVersion = "v3" | "v2" | "invalid";

/** Hostname of a URL, or the string itself when it is already a bare host. */
export function hostOf(urlOrHost: string): string {
  const s = String(urlOrHost || "").trim().toLowerCase();
  if (!s) return "";
  if (s.includes("://")) {
    try { return new URL(s).hostname.toLowerCase(); } catch { return ""; }
  }
  return s.split("/")[0].replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
}

/** True for any URL or hostname inside the .onion TLD (valid address or not). */
export function isOnion(urlOrHost: string): boolean {
  return hostOf(urlOrHost).endsWith(".onion");
}

/**
 * Which generation of hidden service is this? v3 is 56 base32 chars; v2 (16 chars) was
 * switched off by the Tor network in 2021, so recognising it lets us label a reference
 * as historical rather than pretend it is live.
 */
export function onionVersion(urlOrHost: string): OnionVersion {
  const host = hostOf(urlOrHost);
  if (!host.endsWith(".onion")) return "invalid";
  const label = host.slice(0, -".onion".length);
  if (/^[a-z2-7]{56}$/.test(label)) return "v3";
  if (/^[a-z2-7]{16}$/.test(label)) return "v2";
  return "invalid";
}

// ---- handshake ---------------------------------------------------------------

const REPLY5: Record<number, string> = {
  0x01: "general SOCKS server failure",
  0x02: "connection not allowed by ruleset",
  0x03: "network unreachable",
  0x04: "host unreachable (onion service down, or the address is wrong)",
  0x05: "connection refused",
  0x06: "TTL expired",
  0x07: "command not supported",
  0x08: "address type not supported",
};

function once(emitter: any, event: string, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
    const onEv = () => { cleanup(); resolve(); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    function cleanup() {
      clearTimeout(t);
      emitter.removeListener(event, onEv);
      emitter.removeListener("error", onErr);
    }
    emitter.on(event, onEv);
    emitter.on("error", onErr);
  });
}

/**
 * A byte reader over a socket in flowing mode. The handshake needs exact byte counts;
 * anything read past the handshake is pushed back so the HTTP client sees a pristine
 * stream.
 */
function reader(sock: any) {
  let buf: Buffer = Buffer.alloc(0);
  let want = 0;
  let resolve: ((b: Buffer) => void) | null = null;
  let reject: ((e: Error) => void) | null = null;

  const onData = (d: Buffer) => { buf = Buffer.concat([buf, d]); flush(); };
  const onErr = (e: Error) => { const r = reject; resolve = reject = null; r?.(e); };
  const onEnd = () => { const r = reject; resolve = reject = null; r?.(new Error("proxy closed the connection during the SOCKS handshake")); };

  function flush() {
    if (resolve && buf.length >= want) {
      const out = buf.subarray(0, want);
      buf = buf.subarray(want);
      const r = resolve;
      resolve = reject = null;
      r(out);
    }
  }

  sock.on("data", onData);
  sock.on("error", onErr);
  sock.on("close", onEnd);

  return {
    read(n: number): Promise<Buffer> {
      return new Promise((res, rej) => { want = n; resolve = res; reject = rej; flush(); });
    },
    /** Detach and hand any surplus bytes back to the stream. */
    release() {
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("close", onEnd);
      sock.pause();
      if (buf.length) sock.unshift(buf);
    },
  };
}

/** Address block for the CONNECT request: literal IPs by type, everything else by NAME. */
export function addressBlock(host: string): Buffer {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const parts = host.split(".").map((n) => Number(n));
    if (parts.every((n) => n >= 0 && n <= 255)) return Buffer.from([0x01, ...parts]);
  }
  if (host.includes(":")) {
    // IPv6 literal — expand to 16 bytes
    const bytes = ipv6Bytes(host);
    if (bytes) return Buffer.concat([Buffer.from([0x04]), bytes]);
  }
  const name = Buffer.from(host, "utf8");
  if (name.length > 255) throw new Error("hostname too long for SOCKS5");
  return Buffer.concat([Buffer.from([0x03, name.length]), name]);
}

function ipv6Bytes(host: string): Buffer | null {
  const h = host.replace(/^\[|\]$/g, "");
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill("0"), ...tail];
  if (groups.length !== 8) return null;
  const out = Buffer.alloc(16);
  for (let i = 0; i < 8; i++) {
    const v = parseInt(groups[i] || "0", 16);
    if (!Number.isFinite(v) || v < 0 || v > 0xffff) return null;
    out.writeUInt16BE(v, i * 2);
  }
  return out;
}

async function socks5Connect(io: ReturnType<typeof reader>, sock: any, proxy: SocksProxy, host: string, port: number): Promise<void> {
  const methods = proxy.username ? [0x00, 0x02] : [0x00];
  sock.write(Buffer.from([0x05, methods.length, ...methods]));

  const greeting = await io.read(2);
  if (greeting[0] !== 0x05) throw new Error("not a SOCKS5 proxy");
  if (greeting[1] === 0xff) throw new Error("proxy rejected our authentication methods");
  if (greeting[1] === 0x02) {
    if (!proxy.username) throw new Error("proxy requires a username/password");
    const u = Buffer.from(proxy.username, "utf8");
    const p = Buffer.from(proxy.password || "", "utf8");
    sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    const auth = await io.read(2);
    if (auth[1] !== 0x00) throw new Error("proxy rejected the credentials");
  } else if (greeting[1] !== 0x00) {
    throw new Error(`unsupported SOCKS auth method 0x${greeting[1].toString(16)}`);
  }

  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), addressBlock(host), portBuf]));

  const head = await io.read(4);
  if (head[0] !== 0x05) throw new Error("malformed SOCKS5 reply");
  if (head[1] !== 0x00) throw new Error(REPLY5[head[1]] || `SOCKS5 error 0x${head[1].toString(16)}`);
  // consume the bound address so the stream starts clean
  const atyp = head[3];
  if (atyp === 0x01) await io.read(4 + 2);
  else if (atyp === 0x04) await io.read(16 + 2);
  else if (atyp === 0x03) { const l = await io.read(1); await io.read(l[0] + 2); }
  else throw new Error("malformed SOCKS5 reply address");
}

async function socks4Connect(io: ReturnType<typeof reader>, sock: any, proxy: SocksProxy, host: string, port: number): Promise<void> {
  const portBuf = Buffer.alloc(2);
  portBuf.writeUInt16BE(port, 0);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  // 0.0.0.x with x != 0 is the SOCKS4a marker: "resolve this name for me"
  const addr = isIp ? Buffer.from(host.split(".").map(Number)) : Buffer.from([0, 0, 0, 1]);
  const user = Buffer.from(proxy.username || "", "utf8");
  const parts = [Buffer.from([0x04, 0x01]), portBuf, addr, user, Buffer.from([0x00])];
  if (!isIp) parts.push(Buffer.from(host, "utf8"), Buffer.from([0x00]));
  sock.write(Buffer.concat(parts));

  const rep = await io.read(8);
  if (rep[1] !== 0x5a) throw new Error(`SOCKS4 request rejected (0x${rep[1].toString(16)})`);
}

/**
 * Open a TCP connection to `host:port` THROUGH the SOCKS proxy and hand back the raw
 * socket. TLS (if any) is the caller's business — see lib/proxyfetch.
 *
 * Throws on every failure. A caller that wanted a proxy must not receive a direct
 * socket as a consolation prize.
 */
export async function socksConnect(proxy: SocksProxy, host: string, port: number, timeoutMs = 20000): Promise<any> {
  const net: any = await import("node:net");
  const sock = net.connect({ host: proxy.host, port: proxy.port });
  sock.setNoDelay(true);
  try {
    await once(sock, "connect", timeoutMs);
    const io = reader(sock);
    try {
      if (proxy.version === 5) await socks5Connect(io, sock, proxy, host, port);
      else await socks4Connect(io, sock, proxy, host, port);
    } finally {
      io.release();
    }
    return sock;
  } catch (e) {
    sock.destroy();
    throw e;
  }
}
