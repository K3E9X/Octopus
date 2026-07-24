// Face recognition — the same PERSON across DIFFERENT photos, which perceptual hash
// (same file only) and reverse-image (human confirms) can't do automatically. Uses a
// real face-embedding model (@vladmandic/face-api): detect a face, compute a 128-d
// descriptor, and match by Euclidean distance. Runs entirely CLIENT-SIDE (WebGL) —
// no image leaves the browser, no paid API. The model weights are fetched once into
// /public/models (npm run fetch-face-models); until then this degrades gracefully.
//
// Loaded via dynamic import so tfjs/face-api never touch the server or the main bundle.

let faceapi: any = null;
let loaded = false;

/** Load the model weights from `/models` (once). Returns false if they're absent. */
export async function ensureFaceModels(modelUrl = "/models"): Promise<boolean> {
  if (loaded) return true;
  try {
    faceapi = await import("@vladmandic/face-api");
    await faceapi.nets.tinyFaceDetector.loadFromUri(modelUrl);
    await faceapi.nets.faceLandmark68Net.loadFromUri(modelUrl);
    await faceapi.nets.faceRecognitionNet.loadFromUri(modelUrl);
    loaded = true;
    return true;
  } catch {
    return false;
  }
}

/** Compute the 128-d face descriptor for an image URL. Null if no face / CORS blocked. */
export async function describeFace(url: string): Promise<Float32Array | null> {
  if (!faceapi) return null;
  try {
    const img = await faceapi.fetchImage(url); // fetch→blob→img: avoids a tainted canvas
    const res = await faceapi
      .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.4 }))
      .withFaceLandmarks()
      .withFaceDescriptor();
    return res?.descriptor ?? null;
  } catch {
    return null;
  }
}

/** Euclidean distance between two descriptors. Pure — testable without a model. */
export function faceDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return Infinity;
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

export interface FaceItem { id: string; url: string }
export interface FaceMatch { a: string; b: string; distance: number; strong: boolean }

// face-api's canonical thresholds: ≤0.6 same person, tighter ≤0.45 = high confidence.
const MATCH = 0.6;
const STRONG = 0.45;

// Clearly a different person. Well above the same-person threshold, so we only claim
// a contradiction when a face WAS detected in both images and they are far apart.
const MISMATCH = 0.85;

/**
 * Describe every avatar, then pair them up. Returns both matches (same person) and
 * MISMATCHES — two detected faces that are clearly different people. The mismatch is
 * real negative evidence: an investigation has to be able to say no, not only yes.
 */
export async function matchFaces(
  items: FaceItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ matches: FaceMatch[]; mismatches: FaceMatch[]; described: number; scanned: number }> {
  const descs: { id: string; d: Float32Array }[] = [];
  let done = 0;
  for (const it of items) {
    const d = await describeFace(it.url);
    if (d) descs.push({ id: it.id, d });
    onProgress?.(++done, items.length);
  }
  const matches: FaceMatch[] = [];
  const mismatches: FaceMatch[] = [];
  for (let i = 0; i < descs.length; i++) {
    for (let j = i + 1; j < descs.length; j++) {
      const dist = faceDistance(descs[i].d, descs[j].d);
      const pair = { a: descs[i].id, b: descs[j].id, distance: dist, strong: dist <= STRONG };
      if (dist <= MATCH) matches.push(pair);
      else if (dist >= MISMATCH) mismatches.push(pair);
      // the band between MATCH and MISMATCH is genuinely inconclusive — say nothing
    }
  }
  return { matches, mismatches, described: descs.length, scanned: items.length };
}
