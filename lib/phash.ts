// Perceptual hashing of avatars (dHash) — links two accounts when their profile
// photos are visually the same, even after recompression/resize. Deterministic and
// verifiable → a strong correlation signal that cannot hallucinate.
//
// dHash: grayscale-resize to 9x8, compare each pixel to its right neighbour → 64 bits.

import Jimp from "jimp";

const UA = "Octopus-OSINT/0.1 (+https://github.com/K3E9X/Tusna)";
const HASH_W = 9;
const HASH_H = 8;

/** Core dHash: takes row-major grayscale values (HASH_W*HASH_H) → 16-char hex string. */
export function computeDHash(gray: number[], w = HASH_W, h = HASH_H): string {
  let bits = "";
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const l = gray[y * w + x];
      const r = gray[y * w + x + 1];
      bits += l > r ? "1" : "0";
    }
  }
  // 64 bits → 16 hex chars
  let hex = "";
  for (let i = 0; i < bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

const POP = Array.from({ length: 16 }, (_, i) => i.toString(2).split("").filter((c) => c === "1").length);

/** Hamming distance between two hex hashes (number of differing bits). */
export function hamming(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    d += POP[(parseInt(a[i], 16) ^ parseInt(b[i], 16)) & 0xf];
  }
  return d;
}

/** Compute a dHash from raw image bytes already in hand. Returns null on failure. */
export async function dHashFromBuffer(buf: Uint8Array): Promise<string | null> {
  try {
    if (!buf.length) return null;
    const img = await Jimp.read(Buffer.from(buf));
    img.resize(HASH_W, HASH_H).greyscale();
    const data = img.bitmap.data; // RGBA
    const gray: number[] = [];
    for (let i = 0; i < HASH_W * HASH_H; i++) gray.push(data[i * 4]); // R == grayscale
    return computeDHash(gray);
  } catch {
    return null;
  }
}

/** Fetch an image and return its raw bytes (bounded, graceful). Null on failure. */
export async function fetchImageBuffer(url: string, timeoutMs = 5000): Promise<Uint8Array | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA }, cache: "no-store" });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length ? buf : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Similarity verdict for a pair of hashes. */
export function avatarMatch(a?: string, b?: string): { match: boolean; near: boolean; distance: number } {
  if (!a || !b) return { match: false, near: false, distance: 64 };
  const d = hamming(a, b);
  return { match: d <= 6, near: d <= 12, distance: d };
}
