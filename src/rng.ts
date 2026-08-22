/**
 * Deterministic seeded RNG for reproducible routing (bench replay + tests).
 *
 * mulberry32 uniform + Box-Muller normal + Marsaglia-Tsang gamma, composed
 * into Beta sampling for Thompson routing. No external dependencies.
 */
export class SeededRandom {
  private state: number;
  private cachedNormal?: number;

  constructor(public readonly seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal via Box-Muller with second-sample caching. */
  normal(): number {
    if (this.cachedNormal !== undefined) {
      const value = this.cachedNormal;
      this.cachedNormal = undefined;
      return value;
    }
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    const radius = Math.sqrt(-2 * Math.log(u));
    const angle = 2 * Math.PI * v;
    this.cachedNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  /** Gamma draw (Marsaglia-Tsang 2000); shape boost for shape < 1. */
  gamma(shape: number, scale = 1): number {
    if (!(shape > 0)) return 0;
    if (shape < 1) {
      const boost = Math.max(1e-12, this.next());
      return this.gamma(shape + 1, scale) * Math.pow(boost, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = this.normal();
      const candidate = 1 + c * x;
      if (candidate <= 0) continue;
      const v = candidate * candidate * candidate;
      const u = this.next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  /** Beta draw clamped into (0, 1); degenerate parameters fall back to 0.5. */
  beta(alpha: number, beta: number): number {
    if (!(alpha > 0) || !(beta > 0)) return 0.5;
    const x = this.gamma(alpha);
    const y = this.gamma(beta);
    const sum = x + y;
    if (!(sum > 0)) return 0.5;
    return Math.min(1 - 1e-9, Math.max(1e-9, x / sum));
  }
}

/** Stable FNV-1a hash over string parts, used to derive per-turn seeds. */
export function hashSeed(...parts: string[]): number {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193);
    }
  }
  return hash >>> 0;
}
