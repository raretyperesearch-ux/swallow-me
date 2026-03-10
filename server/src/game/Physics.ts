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

  // Kill distance: BODY_RADIUS * 3 = 42 units — very generous, impossible to phase through
  const KILL_DIST = GAME_CONFIG.BODY_RADIUS * 3;
  const KILL_DIST_SQ = KILL_DIST * KILL_DIST;

  // HEAD vs BODY: brute force every snake head against every other snake's segments
  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;
    const prevX = snake.prevHeadX;
    const prevY = snake.prevHeadY;

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      // Check head against EVERY body segment — no spatial grid, no skipping
      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];

        // Point-distance check (current head position)
        const dx = headX - seg.x;
        const dy = headY - seg.y;
        const dSq = dx * dx + dy * dy;

        // Swept line-circle check (prevHead → head path)
        const sweptHit = lineCircleIntersect(prevX, prevY, headX, headY, seg.x, seg.y, KILL_DIST);

        if (dSq < KILL_DIST_SQ || sweptHit) {
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

  // HEAD vs HEAD: both die
  for (const [idA, a] of snakes) {
    if (!a.alive || alreadyDead.has(idA)) continue;

    for (const [idB, b] of snakes) {
      if (idB <= idA || !b.alive || alreadyDead.has(idB)) continue;

      const headCollDist = GAME_CONFIG.HEAD_RADIUS * 2;
      const headCollDistSq = headCollDist * headCollDist;
      const hitPoint = distanceSq(a.headX, a.headY, b.headX, b.headY) < headCollDistSq;
      const hitSweptA = lineCircleIntersect(a.prevHeadX, a.prevHeadY, a.headX, a.headY, b.headX, b.headY, headCollDist);
      const hitSweptB = lineCircleIntersect(b.prevHeadX, b.prevHeadY, b.headX, b.headY, a.headX, a.headY, headCollDist);

      if (hitPoint || hitSweptA || hitSweptB) {
        kills.push({
          killer: null,
          victim: idA,
          victimValue: a.valueUsdc,
          victimName: a.name,
          killerName: "",
          timestamp: Date.now(),
        });
        kills.push({
          killer: null,
          victim: idB,
          victimValue: b.valueUsdc,
          victimName: b.name,
          killerName: "",
          timestamp: Date.now(),
        });
        alreadyDead.add(idA);
        alreadyDead.add(idB);
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

    if (distFromCenter >= arenaRadius) {
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
