// ─── Math Utilities ──────────────────────────────────

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function angleDiff(target: number, current: number): number {
  let d = target - current;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

// ─── Steering ────────────────────────────────────────

export interface SnakeMotionState {
  heading: number;
  speed: number;
  minSpeed: number;
  maxSpeed: number;
}

export interface SteeringConfig {
  dtCap: number;        // 0.05
  deadZonePx: number;   // 6
  turnRateSlow: number; // 5.8 rad/s
  turnRateFast: number; // 3.2 rad/s
}

export const DEFAULT_STEERING: SteeringConfig = {
  dtCap: 0.05,
  deadZonePx: 6,
  turnRateSlow: 5.8,
  turnRateFast: 3.2,
};

export function updateHeadingFromTarget(
  s: SnakeMotionState,
  headX: number,
  headY: number,
  targetX: number,
  targetY: number,
  dtRaw: number,
  cfg: SteeringConfig,
): void {
  const dt = Math.min(dtRaw, cfg.dtCap);

  const dx = targetX - headX;
  const dy = targetY - headY;
  const dist2 = dx * dx + dy * dy;
  if (dist2 < cfg.deadZonePx * cfg.deadZonePx) return;

  const desired = Math.atan2(dy, dx);
  const delta = angleDiff(desired, s.heading);

  const speedT = clamp01(
    (s.speed - s.minSpeed) / (s.maxSpeed - s.minSpeed || 1),
  );
  let maxTurnRate = lerp(cfg.turnRateSlow, cfg.turnRateFast, speedT);

  // Large angle delta (>90°): boost turn rate 1.8x for fast 360s
  if (Math.abs(delta) > Math.PI / 2) maxTurnRate *= 1.8;

  const maxStep = maxTurnRate * dt;
  const step = clamp(delta, -maxStep, +maxStep);
  s.heading += step;
}

// ─── Boost Smoothing ─────────────────────────────────

export interface BoostState {
  boostAlpha: number;   // 0..1
  wantsBoost: boolean;  // raw input
}

export function updateBoost(
  s: BoostState,
  dtRaw: number,
  dtCap = 0.05,
  kUp = 18,
  kDown = 12,
): void {
  const dt = Math.min(dtRaw, dtCap);
  const target = s.wantsBoost ? 1 : 0;
  const k = target > s.boostAlpha ? kUp : kDown;
  const a = 1 - Math.exp(-k * dt);
  s.boostAlpha = s.boostAlpha + (target - s.boostAlpha) * a;
}

// ─── Movement ────────────────────────────────────────

export function moveHead(
  x: number, y: number, angle: number, speedPxPerSec: number, dt: number,
): { x: number; y: number } {
  const safeDt = Math.min(dt, 0.05);
  return {
    x: x + Math.cos(angle) * speedPxPerSec * safeDt,
    y: y + Math.sin(angle) * speedPxPerSec * safeDt,
  };
}

// ─── Chain Constraint ────────────────────────────────

export function chainConstrain(
  segments: { x: number; y: number }[],
  spacing: number,
): void {
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist > spacing) {
      const a = Math.atan2(dy, dx);
      curr.x = prev.x + Math.cos(a) * spacing;
      curr.y = prev.y + Math.sin(a) * spacing;
    }
  }
}

// ─── Collision Geometry ──────────────────────────────

export function getBodyRadius(segmentCount: number): number {
  return 6 + Math.pow(Math.max(1, segmentCount - 20), 0.35) * 3;
}

/** Squared distance from point P to closest point on segment AB */
export function pointToSegmentDistSq(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const ab2 = abx * abx + aby * aby;
  if (ab2 === 0) return apx * apx + apy * apy; // degenerate segment
  const t = clamp01((apx * abx + apy * aby) / ab2);
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}
