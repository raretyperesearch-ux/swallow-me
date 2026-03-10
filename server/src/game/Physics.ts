import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake } from "./Snake";
import { ServerFood } from "./Food";
import { SpatialGrid } from "./SpatialGrid";

export interface KillEvent {
  killer: string | null; // null = wall death
  victim: string;
  victimValue: number;
  victimName: string;
  killerName: string;
  timestamp: number;
}

export interface FoodEatEvent {
  snakeId: string;
  foodId: string;
}

function distanceSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

/**
 * Dynamic body radius — MUST match client visual formula exactly.
 * Small snakes are thin and nimble, big snakes are chunky.
 */
function getBodyRadius(length: number): number {
  return 6 + Math.pow(Math.max(1, length - 20), 0.35) * 3;
}

/**
 * Swept line-circle intersection test.
 * Returns true if line segment (px,py)->(qx,qy) passes within `radius` of circle at (cx,cy).
 * Uses quadratic formula on the parametric ray equation — handles all edge cases.
 */
function lineCircleIntersect(
  px: number, py: number,
  qx: number, qy: number,
  cx: number, cy: number,
  radius: number
): boolean {
  const dx = qx - px;
  const dy = qy - py;
  const fx = px - cx;
  const fy = py - cy;

  const a = dx * dx + dy * dy;
  if (a < 0.0001) {
    // Head didn't move — fall back to point check
    return (fx * fx + fy * fy) < radius * radius;
  }

  const b = 2 * (fx * dx + fy * dy);
  const c = (fx * fx + fy * fy) - radius * radius;

  let discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return false;

  discriminant = Math.sqrt(discriminant);
  const t1 = (-b - discriminant) / (2 * a);
  const t2 = (-b + discriminant) / (2 * a);

  // Check if intersection happens within the line segment (t between 0 and 1)
  return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1) || (t1 < 0 && t2 > 1);
}

/**
 * Ray-casting containment test: is point (px,py) inside the polygon
 * formed by a snake's body segments? Uses crossing-number algorithm.
 * A ray cast in +X from the point; count how many segment edges it crosses.
 * Odd crossings = inside.
 */
function isPointInsideSnakeLoop(
  px: number, py: number,
  segments: { x: number; y: number }[],
  minSegments: number = 30
): boolean {
  const n = segments.length;
  if (n < minSegments) return false; // too short to form a loop

  // Check if the snake's body forms a near-closed loop:
  // head and tail must be within a reasonable distance
  const head = segments[0];
  const tail = segments[n - 1];
  const closeDist = 80; // segments must be this close to form a "loop"
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  if (dx * dx + dy * dy > closeDist * closeDist) return false;

  let crossings = 0;
  for (let i = 0; i < n; i++) {
    const a = segments[i];
    const b = segments[(i + 1) % n];

    // Check if ray from (px, py) in +X direction crosses edge a→b
    if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) {
      // Compute x-coordinate of intersection
      const t = (py - a.y) / (b.y - a.y);
      const ix = a.x + t * (b.x - a.x);
      if (px < ix) {
        crossings++;
      }
    }
  }

  return (crossings & 1) === 1; // odd = inside
}

// Spatial grid for food only — snake collision is brute force (airtight)
const foodGrid = new SpatialGrid(50);

/**
 * Check all head-to-body collisions between snakes.
 * BRUTE FORCE — no spatial grid. Check every head against every other snake's
 * body segments directly. For 10-20 snakes this is fast enough and CANNOT miss.
 * Real money depends on this being airtight.
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  // Debug logging (1% of ticks)
  if (Math.random() < 0.01) {
    let aliveCount = 0;
    let totalSegs = 0;
    for (const [, s] of snakes) {
      if (s.alive) { aliveCount++; totalSegs += s.segments.length; }
    }
    console.log(`[COLLISION TICK] alive=${aliveCount} totalSegs=${totalSegs}`);
  }

  // HEAD vs BODY: brute force with dynamic radius matching client visuals
  // 1.15x multiplier makes collision slightly outside visual edge so it FEELS right
  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;
    const prevX = snake.prevHeadX;
    const prevY = snake.prevHeadY;
    const headRadius = getBodyRadius(snake.length);

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      const otherBodyRadius = getBodyRadius(other.length);
      const killDist = (headRadius + otherBodyRadius) * 1.15; // generous — visual outline adds ~2px
      const killDistSq = killDist * killDist;

      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];
        const dx = headX - seg.x;
        const dy = headY - seg.y;
        const dSq = dx * dx + dy * dy;

        // Log near-misses for debugging
        if (dSq < killDistSq * 4 && Math.random() < 0.1) {
          console.log(`[NEAR MISS] ${snake.name} head near ${other.name} seg${i}: dist=${Math.sqrt(dSq).toFixed(1)} killDist=${killDist.toFixed(1)}`);
        }

        const sweptHit = lineCircleIntersect(prevX, prevY, headX, headY, seg.x, seg.y, killDist);

        if (dSq < killDistSq || sweptHit) {
          console.log(`[KILL] ${other.name} killed ${snake.name}: dist=${Math.sqrt(dSq).toFixed(1)} killDist=${killDist.toFixed(1)} swept=${sweptHit}`);
          kills.push({
            killer: otherId,
            victim: id,
            victimValue: snake.valueUsdc,
            victimName: snake.name,
            killerName: other.name,
            timestamp: Date.now(),
          });
          alreadyDead.add(id);
          break;
        }
      }

      if (alreadyDead.has(id)) break;
    }
  }

  // HEAD vs HEAD: bigger snake eats smaller, same size = both die
  for (const [idA, a] of snakes) {
    if (!a.alive || alreadyDead.has(idA)) continue;

    for (const [idB, b] of snakes) {
      if (idB <= idA || !b.alive || alreadyDead.has(idB)) continue;

      const headCollDist = getBodyRadius(a.length) + getBodyRadius(b.length);
      const dSq = distanceSq(a.headX, a.headY, b.headX, b.headY);

      if (dSq < headCollDist * headCollDist) {
        if (a.length > b.length * 1.1) {
          // A is bigger — A kills B
          kills.push({
            killer: idA, victim: idB,
            victimValue: b.valueUsdc, victimName: b.name, killerName: a.name,
            timestamp: Date.now(),
          });
          alreadyDead.add(idB);
        } else if (b.length > a.length * 1.1) {
          // B is bigger — B kills A
          kills.push({
            killer: idB, victim: idA,
            victimValue: a.valueUsdc, victimName: a.name, killerName: b.name,
            timestamp: Date.now(),
          });
          alreadyDead.add(idA);
        } else {
          // Same size — both die
          kills.push({
            killer: null, victim: idA,
            victimValue: a.valueUsdc, victimName: a.name, killerName: "",
            timestamp: Date.now(),
          });
          kills.push({
            killer: null, victim: idB,
            victimValue: b.valueUsdc, victimName: b.name, killerName: "",
            timestamp: Date.now(),
          });
          alreadyDead.add(idA);
          alreadyDead.add(idB);
        }
      }
    }
  }

  return kills;
}

/**
 * Check snake head vs arena boundary.
 */
export function checkBoundaryCollisions(
  snakes: Map<string, ServerSnake>,
  arenaRadius: number
): KillEvent[] {
  const kills: KillEvent[] = [];

  for (const [id, snake] of snakes) {
    if (!snake.alive) continue;

    const distFromCenter = Math.sqrt(
      snake.headX * snake.headX + snake.headY * snake.headY
    );

    if (distFromCenter + getBodyRadius(snake.length) >= arenaRadius) {
      kills.push({
        killer: null,
        victim: id,
        victimValue: snake.valueUsdc,
        victimName: snake.name,
        killerName: "wall",
        timestamp: Date.now(),
      });
    }
  }

  return kills;
}

/**
 * Check snake heads vs food orbs.
 * Eat radius = HEAD_RADIUS * 3 — very generous.
 */
export function checkFoodCollisions(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>
): FoodEatEvent[] {
  const eats: FoodEatEvent[] = [];
  const eaten = new Set<string>(); // prevent double-eat in same tick

  // Build food grid
  foodGrid.clear();
  for (const [foodId, food] of foods) {
    foodGrid.insert(foodId, food.x, food.y);
  }

  const eatDist = GAME_CONFIG.HEAD_RADIUS * 2;
  const eatDistSq = eatDist * eatDist;

  for (const [snakeId, snake] of snakes) {
    if (!snake.alive) continue;

    const nearbyFoodIds = foodGrid.getNearby(snake.headX, snake.headY);

    for (const foodId of nearbyFoodIds) {
      if (eaten.has(foodId)) continue;
      const food = foods.get(foodId);
      if (!food) continue;

      const dSq = distanceSq(snake.headX, snake.headY, food.x, food.y);

      if (dSq < eatDistSq) {
        eats.push({ snakeId, foodId });
        eaten.add(foodId);
      }
    }
  }

  return eats;
}

/**
 * Containment check: if a snake's head is INSIDE a closed loop
 * formed by another snake's body, that snake dies.
 * This catches the case where a big snake coils around a small one
 * and the small one never technically "touches" a body segment.
 */
export function checkContainmentKills(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      // Only check if the other snake is long enough to form a loop
      if (other.segments.length < 30) continue;

      if (isPointInsideSnakeLoop(snake.headX, snake.headY, other.segments)) {
        kills.push({
          killer: otherId,
          victim: id,
          victimValue: snake.valueUsdc,
          victimName: snake.name,
          killerName: other.name,
          timestamp: Date.now(),
        });
        alreadyDead.add(id);
        break;
      }
    }
  }

  return kills;
}
