// End-to-end transport tests: a real SOCKS5 server, a real HTTP CONNECT proxy and a
// real origin server, all on loopback. Nothing here is mocked, because the thing that
// went wrong before was precisely a transport that looked configured and did nothing.

import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";

import { proxyFetch } from "../lib/proxyfetch";

// ---- helpers -----------------------------------------------------------------

function listen(server: any): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

interface SocksSeen { atyp: number; host: string; port: number }

/**
 * Minimal SOCKS5 server. Records what it was asked for, so we can assert the client
 * sends hostnames as NAMES (no local DNS) rather than pre-resolved addresses.
 */
function socksServer(opts: { auth?: [string, string]; failWith?: number } = {}) {
  const seen: SocksSeen[] = [];
  const creds: { user: string; pass: string }[] = [];
  const server = net.createServer((sock) => {
    let stage = 0;
    let buf = Buffer.alloc(0);
    let upstream: net.Socket | null = null;

    sock.on("error", () => {});
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); step(); });

    function step() {
      if (stage === 0) {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        if (opts.auth) { sock.write(Buffer.from([5, 2])); stage = 1; }
        else { sock.write(Buffer.from([5, 0])); stage = 2; }
        return step();
      }
      if (stage === 1) {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 3 + ulen) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const user = buf.subarray(2, 2 + ulen).toString();
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        creds.push({ user, pass });
        const ok = user === opts.auth![0] && pass === opts.auth![1];
        sock.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return sock.end();
        stage = 2;
        return step();
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        let host = "";
        let need = 0;
        if (atyp === 1) { need = 10; if (buf.length < need) return; host = [...buf.subarray(4, 8)].join("."); }
        else if (atyp === 3) { const l = buf[4]; need = 5 + l + 2; if (buf.length < need) return; host = buf.subarray(5, 5 + l).toString(); }
        else return sock.destroy();
        const port = buf.readUInt16BE(need - 2);
        buf = buf.subarray(need);
        seen.push({ atyp, host, port });

        if (opts.failWith != null) {
          sock.write(Buffer.from([5, opts.failWith, 0, 1, 0, 0, 0, 0, 0, 0]));
          return sock.end();
        }
        stage = 3;
        const up = net.connect({ host: host === "localhost" ? "127.0.0.1" : host, port }, () => {
          upstream = up;
          sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buf.length) { up.write(buf); buf = Buffer.alloc(0); }
          up.on("data", (d) => sock.write(d));
          up.on("close", () => sock.end());
        });
        up.on("error", () => sock.destroy());
        return;
      }
      // stage 3: relay client → upstream
      if (upstream && buf.length) { upstream.write(buf); buf = Buffer.alloc(0); }
    }
  });
  return { server, seen, creds };
}

/** Minimal HTTP CONNECT proxy. */
function connectProxy() {
  const seen: string[] = [];
  const server = http.createServer();
  server.on("connect", (req, clientSock: any, head: Buffer) => {
    seen.push(req.url || "");
    const [host, port] = String(req.url).split(":");
    const up = net.connect({ host, port: Number(port) }, () => {
      clientSock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head?.length) up.write(head);
      up.pipe(clientSock);
      clientSock.pipe(up);
    });
    up.on("error", () => clientSock.destroy());
    clientSock.on("error", () => up.destroy());
  });
  return { server, seen };
}

// ---- tests -------------------------------------------------------------------

test("SOCKS5: a real request travels through the proxy and comes back intact", async (t) => {
  const origin = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ path: req.url, ua: req.headers["user-agent"], host: req.headers.host }));
  });
  const { server: socks, seen } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://localhost:${oPort}/profile?q=1`, `socks5://127.0.0.1:${sPort}`, {
    headers: { "User-Agent": "Mozilla/5.0 (test)" },
    timeoutMs: 8000,
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, "/profile?q=1");
  assert.equal(body.ua, "Mozilla/5.0 (test)", "the browser-shaped identity survives the proxy");
  assert.equal(body.host, `localhost:${oPort}`);

  // the OPSEC-critical assertion: the destination went to the proxy as a NAME (ATYP 3).
  // Pre-resolving it locally would hand the analyst's resolver the target — and .onion
  // cannot be resolved locally at all, so this is what makes Tor work.
  assert.equal(seen.length, 1);
  assert.equal(seen[0].atyp, 3);
  assert.equal(seen[0].host, "localhost");
  assert.equal(seen[0].port, oPort);
});

test("SOCKS5: username/password authentication", async (t) => {
  const origin = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("ok"); });
  const { server: socks, creds } = socksServer({ auth: ["agent", "p@ss word"] });
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(
    `http://127.0.0.1:${oPort}/`,
    `socks5://agent:${encodeURIComponent("p@ss word")}@127.0.0.1:${sPort}`,
    { timeoutMs: 8000 },
  );
  assert.equal(await res.text(), "ok");
  assert.deepEqual(creds, [{ user: "agent", pass: "p@ss word" }]);
});

test("SOCKS5: bad credentials fail closed — no request escapes", async (t) => {
  const origin = http.createServer((_req, res) => res.end("should never be reached"));
  const { server: socks } = socksServer({ auth: ["agent", "correct"] });
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  await assert.rejects(
    () => proxyFetch(`http://127.0.0.1:${oPort}/`, `socks5://agent:wrong@127.0.0.1:${sPort}`, { timeoutMs: 8000 }),
    /credentials/i,
  );
});

test("SOCKS5: a proxy refusal is an error, never a direct connection", async (t) => {
  // 0x04 = host unreachable, what Tor returns for a dead onion service.
  const { server: socks } = socksServer({ failWith: 0x04 });
  const sPort = await listen(socks);
  t.after(() => socks.close());

  await assert.rejects(
    () => proxyFetch("http://example.com/", `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000 }),
    /host unreachable/i,
  );
});

test("SOCKS5: an unreachable proxy throws rather than falling back", async (t) => {
  // port 1 is reliably closed; the point is that nothing goes direct.
  await assert.rejects(() => proxyFetch("http://example.com/", "socks5://127.0.0.1:1", { timeoutMs: 3000 }));
});

test("chunked responses are reassembled", async (t) => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" }); // no content-length → chunked
    res.write("<html><body>part one ");
    res.write("part two</body>");
    res.end("</html>");
  });
  const { server: socks } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/`, `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000 });
  assert.equal(await res.text(), "<html><body>part one part two</body></html>");
});

test("redirects are followed through the proxy", async (t) => {
  const origin = http.createServer((req, res) => {
    if (req.url === "/old") { res.writeHead(302, { location: "/new" }); return res.end(); }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("arrived");
  });
  const { server: socks, seen } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/old`, `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000 });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "arrived");
  assert.equal(seen.length, 2, "each hop is a fresh tunnel through the proxy");
});

test("404s are reported as 404s, not as transport errors", async (t) => {
  const origin = http.createServer((_req, res) => { res.writeHead(404); res.end("nope"); });
  const { server: socks } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/x`, `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000 });
  assert.equal(res.status, 404);
  assert.equal(res.ok, false);
});

test("response headers survive, so rate-limit detection still works", async (t) => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(403, { "x-ratelimit-remaining": "0", "content-type": "application/json" });
    res.end("{}");
  });
  const { server: socks } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/`, `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000 });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get("x-ratelimit-remaining"), "0");
});

test("HTTP CONNECT proxies work too (the non-Tor path)", async (t) => {
  const origin = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("via connect"); });
  const { server: proxy, seen } = connectProxy();
  const oPort = await listen(origin);
  const pPort = await listen(proxy);
  t.after(() => { origin.close(); proxy.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/`, `http://127.0.0.1:${pPort}`, { timeoutMs: 8000 });
  assert.equal(await res.text(), "via connect");
  assert.deepEqual(seen, [`127.0.0.1:${oPort}`]);
});

test("the body is capped — a hidden service cannot stream us to death", async (t) => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(50_000));
  });
  const { server: socks } = socksServer();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(() => { origin.close(); socks.close(); });

  const res = await proxyFetch(`http://127.0.0.1:${oPort}/`, `socks5://127.0.0.1:${sPort}`, { timeoutMs: 8000, maxBytes: 1000 });
  assert.equal((await res.text()).length, 1000);
});
