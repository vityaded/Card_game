export function nowMs() { return Date.now(); }

export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function shuffleInPlace(arr, rng=Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function handTotal(handCounts) {
  let s = 0;
  for (const v of handCounts.values()) s += v;
  return s;
}

// Deterministic-ish rng from seed
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function() {
    t += 0x6D2B79F5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}
