import { describe, it, expect } from "vitest";
import {
  clamp,
  clamp01,
  lerp,
  angleDiff,
  updateHeadingFromTarget,
  chainConstrain,
  getBodyRadius,
  pointToSegmentDistSq,
  DEFAULT_STEERING,
} from "../steering";
import type { SnakeMotionState, SteeringConfig } from "../steering";

// ─── clamp / clamp01 / lerp ─────────────────────────

describe("clamp", () => {
  it("clamps below min", () => expect(clamp(-5, 0, 10)).toBe(0));
  it("clamps above max", () => expect(clamp(15, 0, 10)).toBe(10));
  it("passes through in range", () => expect(clamp(5, 0, 10)).toBe(5));
});

describe("clamp01", () => {
  it("clamps to 0-1", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
    expect(clamp01(0.7)).toBeCloseTo(0.7);
  });
});

describe("lerp", () => {
  it("returns a at t=0", () => expect(lerp(10, 20, 0)).toBe(10));
  it("returns b at t=1", () => expect(lerp(10, 20, 1)).toBe(20));
  it("returns midpoint at t=0.5", () => expect(lerp(10, 20, 0.5)).toBe(15));
});

// ─── angleDiff ──────────────────────────────────────

describe("angleDiff", () => {
  it("returns 0 for same angle", () => {
    expect(angleDiff(1.0, 1.0)).toBeCloseTo(0);
  });

  it("handles wrapping from -PI to PI", () => {
    // Target just past PI, current just below -PI
    const d = angleDiff(3.0, -3.0);
    expect(Math.abs(d)).toBeLessThan(Math.PI);
  });

  it("shortest path is positive", () => {
    const d = angleDiff(1.0, 0.0);
    expect(d).toBeCloseTo(1.0);
  });

  it("shortest path is negative", () => {
    const d = angleDiff(0.0, 1.0);
    expect(d).toBeCloseTo(-1.0);
  });

  it("wraps correctly across boundary", () => {
    // 3.14 to -3.14 should be ~0.08, not ~6.28
    const d = angleDiff(Math.PI - 0.04, -(Math.PI - 0.04));
    expect(Math.abs(d)).toBeLessThan(0.1);
  });
});

// ─── updateHeadingFromTarget ────────────────────────

describe("updateHeadingFromTarget", () => {
  const cfg: SteeringConfig = {
    dtCap: 0.05,
    deadZonePx: 24,
    turnRateSlow: 4.5,
    turnRateFast: 2.2,
  };

  it("does not turn inside dead zone", () => {
    const s: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };
    updateHeadingFromTarget(s, 100, 100, 110, 110, 1 / 60, cfg); // ~14px away
    expect(s.heading).toBe(0);
  });

  it("turns toward target outside dead zone", () => {
    const s: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };
    updateHeadingFromTarget(s, 0, 0, 0, 100, 1 / 60, cfg); // 100px above, target angle = PI/2
    expect(s.heading).toBeGreaterThan(0);
  });

  it("clamps turn to maxTurnRate * dt", () => {
    const s: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };
    // At min speed, turnRate = 4.5 rad/s. At dt=1/60, maxStep = 0.075
    updateHeadingFromTarget(s, 0, 0, 0, 100, 1 / 60, cfg);
    expect(s.heading).toBeLessThanOrEqual(0.075 + 0.001);
  });

  it("turn rate is slower at higher speed", () => {
    const sSlow: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };
    const sFast: SnakeMotionState = { heading: 0, speed: 480, minSpeed: 240, maxSpeed: 480 };
    updateHeadingFromTarget(sSlow, 0, 0, 0, 100, 1 / 60, cfg);
    updateHeadingFromTarget(sFast, 0, 0, 0, 100, 1 / 60, cfg);
    // Fast speed should turn less per frame
    expect(sFast.heading).toBeLessThan(sSlow.heading);
  });

  it("produces near-identical results at 30fps and 144fps", () => {
    // Simulate 1 second of turning at 30fps vs 144fps
    const s30: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };
    const s144: SnakeMotionState = { heading: 0, speed: 240, minSpeed: 240, maxSpeed: 480 };

    for (let i = 0; i < 30; i++) {
      updateHeadingFromTarget(s30, 0, 0, 0, 100, 1 / 30, cfg);
    }
    for (let i = 0; i < 144; i++) {
      updateHeadingFromTarget(s144, 0, 0, 0, 100, 1 / 144, cfg);
    }

    // Both should converge to ~PI/2 after 1 second at turnRate 4.5 rad/s
    // Allow 0.1 rad tolerance (the clamped nature means exact parity isn't possible)
    expect(Math.abs(s30.heading - s144.heading)).toBeLessThan(0.1);
  });
});

// ─── chainConstrain ─────────────────────────────────

describe("chainConstrain", () => {
  it("enforces spacing between segments", () => {
    const segs = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    chainConstrain(segs, 4);
    // seg[0] untouched
    expect(segs[0].x).toBe(0);
    // seg[1] should be 4 units from seg[0]
    const d01 = Math.sqrt((segs[1].x - segs[0].x) ** 2 + (segs[1].y - segs[0].y) ** 2);
    expect(d01).toBeCloseTo(4, 5);
    // seg[2] should be 4 units from seg[1]
    const d12 = Math.sqrt((segs[2].x - segs[1].x) ** 2 + (segs[2].y - segs[1].y) ** 2);
    expect(d12).toBeCloseTo(4, 5);
  });

  it("does not expand segments that are already close", () => {
    const segs = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
    ];
    chainConstrain(segs, 4);
    expect(segs[1].x).toBe(2); // unchanged since dist < spacing
  });
});

// ─── getBodyRadius ──────────────────────────────────

describe("getBodyRadius", () => {
  it("returns base radius for small snakes", () => {
    expect(getBodyRadius(10)).toBeCloseTo(6 + Math.pow(1, 0.35) * 3);
  });

  it("increases with segment count", () => {
    expect(getBodyRadius(100)).toBeGreaterThan(getBodyRadius(40));
  });
});

// ─── pointToSegmentDistSq ───────────────────────────

describe("pointToSegmentDistSq", () => {
  it("returns 0 for point on segment", () => {
    expect(pointToSegmentDistSq(5, 0, 0, 0, 10, 0)).toBeCloseTo(0);
  });

  it("returns perpendicular distance squared", () => {
    // Point at (5,3), segment from (0,0) to (10,0) → dist = 3, distSq = 9
    expect(pointToSegmentDistSq(5, 3, 0, 0, 10, 0)).toBeCloseTo(9);
  });

  it("returns distance to nearest endpoint when past segment", () => {
    // Point at (15,0), segment from (0,0) to (10,0) → dist to B = 5, distSq = 25
    expect(pointToSegmentDistSq(15, 0, 0, 0, 10, 0)).toBeCloseTo(25);
  });

  it("handles degenerate (zero-length) segment", () => {
    expect(pointToSegmentDistSq(3, 4, 0, 0, 0, 0)).toBeCloseTo(25);
  });
});
