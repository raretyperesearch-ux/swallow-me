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

// Reusable spatial grids
const bodyGrid = new SpatialGrid(100);
const foodGrid = new SpatialGrid(100);

/**
 * Check all head-to-body collisions between snakes.
 * Uses spatial grid for broad phase, then precise per-segment check.
 * Collision threshold is tight (1.1x) — matches visual body radius on screen.
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  // BROAD PHASE: Build spatial grid of all body segments (skip segment 0 = head position only)
  bodyGrid.clear();
  for (const [id, snake] of snakes) {
    if (!snake.alive) continue;
    for (let i = 1; i < snake.segments.length; i += 1) {
      bodyGrid.insert(id, snake.segments[i].x, snake.segments[i].y);
    }
  }

  // NARROW PHASE: Swept line-circle test from prevHead to head against body segments
  const collisionDist = (GAME_CONFIG.HEAD_RADIUS + GAME_CONFIG.BODY_RADIUS) * 1.1;

  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;
    const prevX = snake.prevHeadX;
    const prevY = snake.prevHeadY;

    // Query spatial grid at BOTH previous and current head positions
    // to catch cases where the head crosses a cell boundary during movement
    const nearbyIds1 = bodyGrid.getNearby(prevX, prevY);
    const nearbyIds2 = bodyGrid.getNearby(headX, headY);
    const nearbyIds = new Set([...nearbyIds1, ...nearbyIds2]);

    // For boosting snakes (16 units/tick), also check the midpoint
    if (snake.boosting) {
      const midX = (prevX + headX) / 2;
      const midY = (prevY + headY) / 2;
      const nearbyIdsMid = bodyGrid.getNearby(midX, midY);
      for (const mid of nearbyIdsMid) nearbyIds.add(mid);
    }

    for (const otherId of nearbyIds) {
      if (otherId === id || alreadyDead.has(otherId)) continue;
      const other = snakes.get(otherId);
      if (!other || !other.alive) continue;

      // Swept check: test line segment (prevHead → head) against each body circle
      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];

        if (lineCircleIntersect(prevX, prevY, headX, headY, seg.x, seg.y, collisionDist)) {
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

  // Head-to-head: both die (swept — check if movement paths intersect)
  const heads = Array.from(snakes.entries()).filter(
    ([id, s]) => s.alive && !alreadyDead.has(id)
  );
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const [idA, a] = heads[i];
      const [idB, b] = heads[j];
      if (alreadyDead.has(idA) || alreadyDead.has(idB)) continue;

      const headCollDist = GAME_CONFIG.HEAD_RADIUS * 2;
      // Check swept path of both heads against each other's current position
      const hitCurrent = distanceSq(a.headX, a.headY, b.headX, b.headY) < headCollDist * headCollDist;
      const hitSweptA = lineCircleIntersect(a.prevHeadX, a.prevHeadY, a.headX, a.headY, b.headX, b.headY, headCollDist);
      const hitSweptB = lineCircleIntersect(b.prevHeadX, b.prevHeadY, b.headX, b.headY, a.headX, a.headY, headCollDist);
      if (hitCurrent || hitSweptA || hitSweptB) {
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
