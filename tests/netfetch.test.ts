import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { newHealth, noteOutcome, healthNote, fetchJSON, setEgress, torActive, clearNetCache } from "../lib/netfetch.ts";

test("health records rate limits and failures separately", () => {
  const h = newHealth();
  noteOutcome(h, "api.github.com", "rate-limited");
  noteOutcome(h, "api.github.com", "rate-limited"); // dedupe
  noteOutcome(h, "gitlab.com", "error");
  noteOutcome(h, "reddit.com", "not-found");       // not a degradation
  assert.deepEqual(h.rateLimited, ["api.github.com"]);
  assert.deepEqual(h.failed, ["gitlab.com"]);
});

test("healthNote says INCOMPLETE, never implies a negative result", () => {
  const h = newHealth();
  assert.equal(healthNote(h), "");
  noteOutcome(h, "api.github.com", "rate-limited");
  const note = healthNote(h);
  assert.ok(note.includes("rate-limited"));
  assert.ok(note.includes("incomplete"));
});

// ---- integration: the configured egress path is the one actually used ---------

/** Minimal SOCKS5 relay that records the destinations it was asked for. */
function relay() {
  const seen: string[] = [];
  const server = net.createServer((sock) => {
    let stage = 0, buf = Buffer.alloc(0), up: net.Socket | null = null;
    sock.on("error", () => {});
    sock.on("data", (d) => { buf = Buffer.concat([buf, d]); step(); });
    function step() {
      if (stage === 0) {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n); sock.write(Buffer.from([5, 0])); stage = 2; return step();
      }
      if (stage === 2) {
        if (buf.length < 5) return;
        const l = buf[4], need = 5 + l + 2;
        if (buf[3] !== 3 || buf.length < need) return;
        const host = buf.subarray(5, 5 + l).toString();
        const port = buf.readUInt16BE(need - 2);
        buf = buf.subarray(need);
        seen.push(`${host}:${port}`);
        stage = 3;
        const u = net.connect({ host: host === "localhost" ? "127.0.0.1" : host, port }, () => {
          up = u; sock.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          if (buf.length) { u.write(buf); buf = Buffer.alloc(0); }
          u.on("data", (d) => sock.write(d)); u.on("close", () => sock.end());
        });
        u.on("error", () => sock.destroy());
        return;
      }
      if (up && buf.length) { up.write(buf); buf = Buffer.alloc(0); }
    }
  });
  return { server, seen };
}

const listen = (s: any): Promise<number> => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));

test("with a proxy configured, collection traffic really goes through it", async (t) => {
  const origin = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ login: "target" }));
  });
  const { server: socks, seen } = relay();
  const oPort = await listen(origin);
  const sPort = await listen(socks);
  t.after(async () => { origin.close(); socks.close(); setEgress({}); await clearNetCache(); });

  setEgress({ proxy: `socks5://127.0.0.1:${sPort}`, caseId: "test-case" });
  assert.equal(torActive(), true, "a SOCKS proxy makes hidden services reachable");

  const r = await fetchJSON(`http://localhost:${oPort}/users/target`, { noCache: true, timeoutMs: 8000 });
  assert.equal(r.outcome, "ok");
  assert.equal((r.data as any).login, "target");
  assert.deepEqual(seen, [`localhost:${oPort}`], "the request was tunnelled, not sent direct");
});

test("a broken proxy BLOCKS the request instead of quietly going direct", async (t) => {
  const origin = http.createServer((_req, res) => { res.writeHead(200); res.end("{}"); });
  const oPort = await listen(origin);
  t.after(async () => { origin.close(); setEgress({}); await clearNetCache(); });

  setEgress({ proxy: "socks5://127.0.0.1:1" }); // nothing listening
  const r = await fetchJSON(`http://localhost:${oPort}/x`, { noCache: true, timeoutMs: 3000 });
  assert.notEqual(r.outcome, "ok");
  assert.equal(r.data, null);
});

test("a .onion request with no Tor is refused by policy, and never cached", async (t) => {
  t.after(async () => { setEgress({}); await clearNetCache(); });
  setEgress({ proxy: "" });
  const url = "http://juhanurmihxlp77nkq76byazcldy2hlmovfu2epvl5ankdibsot4csyd.onion/search/?q=x";
  const r = await fetchJSON(url, { timeoutMs: 2000 });
  assert.equal(r.outcome, "blocked-by-policy");
  assert.match(r.policyReason || "", /SOCKS5/);
  assert.equal(torActive(), false);
  // and it must not be remembered: configure Tor and the same URL must be retried
  const again = await fetchJSON(url, { timeoutMs: 2000 });
  assert.equal(again.cached, undefined);
});
