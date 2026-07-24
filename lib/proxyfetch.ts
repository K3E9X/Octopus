// HTTP over a proxied socket — the transport that makes the proxy setting real.
//
// Node's global fetch cannot be told to use a proxy: there is no agent option, and the
// usual answer (an undici Agent/ProxyAgent) is not available to us — `undici` is not a
// resolvable module in this project or inside Next's runtime. Relying on it meant the
// proxy field looked configured and quietly did nothing, which for a .onion query is
// the worst possible outcome: the request goes out from the analyst's real address.
//
// So we speak HTTP/1.1 ourselves over a socket we control:
//   socks*://  → lib/socks opens the tunnel (this is how Tor works, and .onion with it)
//   http(s):// → CONNECT tunnel through the proxy
// then TLS on top when the target is https, and a hand-rolled HTTP/1.1 exchange whose
// result is wrapped in a standard Response so nothing downstream has to care.
//
// Deliberately small: one request, no keep-alive, no pipelining. Collection traffic is
// low-rate by design (jittered, browser-shaped), so connection reuse buys nothing and
// costs the ability to reason about what is on the wire.

import { parseSocks, isSocksUrl, socksConnect, hostOf } from "./socks";

export interface ProxyFetchOpts {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** how many redirects to follow (0 = none) */
  maxRedirects?: number;
  /** cap on the body we will read — a hidden service can serve an endless stream */
  maxBytes?: number;
}

function once(emitter: any, event: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
    const ok = () => { cleanup(); resolve(); };
    const bad = (e: Error) => { cleanup(); reject(e); };
    function cleanup() {
      clearTimeout(t);
      emitter.removeListener(event, ok);
      emitter.removeListener("error", bad);
    }
    emitter.on(event, ok);
    emitter.on("error", bad);
  });
}

/** Open a socket to the target through an HTTP CONNECT proxy. */
async function connectTunnel(proxyUrl: string, host: string, port: number, timeoutMs: number): Promise<any> {
  const u = new URL(proxyUrl);
  const secureProxy = u.protocol === "https:";
  const net: any = await import("node:net");
  const tls: any = await import("node:tls");
  const pPort = Number(u.port) || (secureProxy ? 443 : 8080);

  let sock: any;
  if (secureProxy) {
    sock = tls.connect({ host: u.hostname, port: pPort, servername: u.hostname });
    await once(sock, "secureConnect", timeoutMs);
  } else {
    sock = net.connect({ host: u.hostname, port: pPort });
    await once(sock, "connect", timeoutMs);
  }
  sock.setNoDelay(true);

  const auth = u.username
    ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || "")}`).toString("base64")}\r\n`
    : "";
  const target = `${host}:${port}`;
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}Connection: keep-alive\r\n\r\n`);

  // read until the end of the CONNECT response headers
  const head = await readUntil(sock, "\r\n\r\n", timeoutMs);
  const status = Number(head.text.match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0);
  if (status !== 200) {
    sock.destroy();
    throw new Error(`proxy refused CONNECT (HTTP ${status || "?"})`);
  }
  if (head.rest.length) sock.unshift(head.rest);
  return sock;
}

/** Read from a socket until `marker`, returning the text before it and the surplus. */
function readUntil(sock: any, marker: string, timeoutMs: number): Promise<{ text: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const t = setTimeout(() => { cleanup(); reject(new Error("timeout reading response headers")); }, timeoutMs);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf(marker);
      if (i >= 0) {
        cleanup();
        resolve({ text: buf.subarray(0, i).toString("latin1"), rest: buf.subarray(i + marker.length) });
      } else if (buf.length > 256 * 1024) {
        cleanup();
        reject(new Error("response headers too large"));
      }
    };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    const onEnd = () => { cleanup(); reject(new Error("connection closed before the response headers were complete")); };
    function cleanup() {
      clearTimeout(t);
      sock.removeListener("data", onData);
      sock.removeListener("error", onErr);
      sock.removeListener("close", onEnd);
      sock.pause();
    }
    sock.on("data", onData);
    sock.on("error", onErr);
    sock.on("close", onEnd);
    sock.resume();
  });
}

/** Open a socket to `url`'s origin through the proxy, TLS-wrapped when needed. */
export async function proxyConnect(proxyUrl: string, url: URL, timeoutMs: number): Promise<any> {
  const https = url.protocol === "https:";
  const port = Number(url.port) || (https ? 443 : 80);
  const host = url.hostname.replace(/^\[|\]$/g, "");

  let sock: any;
  if (isSocksUrl(proxyUrl)) {
    const p = parseSocks(proxyUrl);
    if (!p) throw new Error("unparsable SOCKS proxy URL");
    sock = await socksConnect(p, host, port, timeoutMs);
  } else {
    sock = await connectTunnel(proxyUrl, host, port, timeoutMs);
  }

  if (!https) return sock;
  const tls: any = await import("node:tls");
  const secure = tls.connect({
    socket: sock,
    servername: /^[\d.]+$/.test(host) ? undefined : host,
    ALPNProtocols: ["http/1.1"],
  });
  try {
    await once(secure, "secureConnect", timeoutMs);
  } catch (e) {
    secure.destroy();
    sock.destroy();
    throw e;
  }
  return secure;
}

function parseHeaders(raw: string): { status: number; headers: Headers } {
  const lines = raw.split("\r\n");
  const status = Number(lines[0].match(/^HTTP\/1\.[01] (\d{3})/)?.[1] || 0);
  const headers = new Headers();
  for (const line of lines.slice(1)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    // set-cookie can repeat; Headers.append keeps them all
    try { headers.append(k, v); } catch { /* malformed header name */ }
  }
  return { status, headers };
}

/** Read the body, honouring Content-Length / chunked / close-delimited framing. */
function readBody(sock: any, headers: Headers, seed: Buffer, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  const chunked = /chunked/i.test(headers.get("transfer-encoding") || "");
  const len = Number(headers.get("content-length"));
  return new Promise((resolve, reject) => {
    let buf = seed;
    const t = setTimeout(() => { cleanup(); resolve(finish()); }, timeoutMs);

    const done = () => {
      if (buf.length >= maxBytes) return true;
      if (chunked) return endOfChunks(buf);
      if (Number.isFinite(len) && len >= 0) return buf.length >= len;
      return false; // close-delimited: wait for the socket to end
    };
    const finish = (): Buffer => {
      const body = chunked ? dechunk(buf) : Number.isFinite(len) ? buf.subarray(0, len) : buf;
      return body.subarray(0, maxBytes);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (done()) { cleanup(); resolve(finish()); }
    };
    const onEnd = () => { cleanup(); resolve(finish()); };
    const onErr = (e: Error) => { cleanup(); reject(e); };
    function cleanup() {
      clearTimeout(t);
      sock.removeListener("data", onData);
      sock.removeListener("end", onEnd);
      sock.removeListener("close", onEnd);
      sock.removeListener("error", onErr);
      sock.destroy();
    }

    if (done()) { clearTimeout(t); sock.destroy(); return resolve(finish()); }
    sock.on("data", onData);
    sock.on("end", onEnd);
    sock.on("close", onEnd);
    sock.on("error", onErr);
    sock.resume();
  });
}

function endOfChunks(buf: Buffer): boolean {
  // the terminator is a zero-length chunk: "0\r\n\r\n"
  return buf.includes("\r\n0\r\n\r\n") || buf.subarray(0, 5).toString("latin1") === "0\r\n\r\n";
}

function dechunk(buf: Buffer): Buffer {
  const out: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf("\r\n", i);
    if (nl < 0) break;
    const size = parseInt(buf.subarray(i, nl).toString("latin1").split(";")[0].trim(), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    const start = nl + 2;
    out.push(buf.subarray(start, start + size));
    i = start + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * fetch(), but through a proxy. Returns a real Response so callers are unchanged.
 * Never falls back to a direct connection: if the proxy path fails, the call throws.
 */
export async function proxyFetch(rawUrl: string, proxyUrl: string, opts: ProxyFetchOpts = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let url = new URL(rawUrl);
  let redirectsLeft = opts.maxRedirects ?? 5;

  for (;;) {
    const sock = await proxyConnect(proxyUrl, url, timeoutMs);
    const path = url.pathname + url.search;
    const headers: Record<string, string> = {
      Host: url.host,
      Connection: "close",
      // identity encoding: decompressing would mean carrying zlib plumbing for no
      // intelligence gain, and a wrong guess would corrupt the page silently.
      "Accept-Encoding": "identity",
      ...(opts.headers || {}),
    };
    const head = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    sock.write(`GET ${path} HTTP/1.1\r\n${head}\r\n\r\n`);

    let raw: { text: string; rest: Buffer };
    try {
      raw = await readUntil(sock, "\r\n\r\n", timeoutMs);
    } catch (e) {
      sock.destroy();
      throw e;
    }
    const { status, headers: resHeaders } = parseHeaders(raw.text);
    if (!status) { sock.destroy(); throw new Error("malformed HTTP response"); }

    const location = resHeaders.get("location");
    if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
      sock.destroy();
      redirectsLeft--;
      url = new URL(location, url);
      continue;
    }

    const body = await readBody(sock, resHeaders, raw.rest, timeoutMs, maxBytes);
    // 204/304 must have no body, and Response rejects one
    const nullBody = status === 204 || status === 304 || status === 205;
    return new Response(nullBody ? null : body, { status, headers: resHeaders });
  }
}
