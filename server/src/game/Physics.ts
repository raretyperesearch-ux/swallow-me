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

// Reusable spatial grids (avoid per-tick allocation)
const bodyGrid = new SpatialGrid(300);
const foodGrid = new SpatialGrid(300);

/**
 * Check all head-to-body collisions between snakes using spatial grid.
 * O(n) average instead of O(n²).
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  // Build spatial grid of all body segments
  bodyGrid.clear();
  for (const [id, snake] of snakes) {
    if (!snake.alive) continue;
    // Insert body segments into grid (skip first 3 — head area)
    // Use stride of 3 for dense coverage without inserting every single segment
    for (let i = 3; i < snake.segments.length; i += 3) {
      bodyGrid.insert(id, snake.segments[i].x, snake.segments[i].y);
    }
  }

  // Check each snake's head against nearby body segments
  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;

    // Get snake IDs that have body segments near this head
    const nearbyIds = bodyGrid.getNearby(headX, headY);

    for (const otherId of nearbyIds) {
      if (otherId === id || alreadyDead.has(otherId)) continue;
      const other = snakes.get(otherId);
      if (!other || !other.alive) continue;

      // Now do precise check against this snake's body segments
      const startSeg = 3;
      const collisionDist = (GAME_CONFIG.HEAD_RADIUS + GAME_CONFIG.BODY_RADIUS) * 1.5;
      const collisionDistSq = collisionDist * collisionDist;

      for (let i = startSeg; i < other.segments.length; i++) {
        const seg = other.segments[i];
        const dSq = distanceSq(headX, headY, seg.x, seg.y);

        if (dSq < collisionDistSq) {
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

  // Head-to-head: both die
  const heads = Array.from(snakes.entries()).filter(
    ([id, s]) => s.alive && !alreadyDead.has(id)
  );
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const [idA, a] = heads[i];
      const [idB, b] = heads[j];
      if (alreadyDead.has(idA) || alreadyDead.has(idB)) continue;

      const collisionDist = GAME_CONFIG.HEAD_RADIUS * 2;
      const dSq = distanceSq(a.headX, a.headY, b.headX, b.headY);
      if (dSq < collisionDist * collisionDist) {
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
 * Check snake heads vs food orbs using spatial grid.
 */
export function checkFoodCollisions(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>
): FoodEatEvent[] {
  const eats: FoodEatEvent[] = [];

  // Build food grid
  foodGrid.clear();
  for (const [foodId, food] of foods) {
    foodGrid.insert(foodId, food.x, food.y);
  }

  for (const [snakeId, snake] of snakes) {
    if (!snake.alive) continue;

    // Only check food near this snake's head
    const nearbyFoodIds = foodGrid.getNearby(snake.headX, snake.headY);

    for (const foodId of nearbyFoodIds) {
      const food = foods.get(foodId);
      if (!food) continue;

      const isDeath = food.size === 2;
      const eatDist = isDeath
        ? GAME_CONFIG.HEAD_RADIUS * 3
        : GAME_CONFIG.HEAD_RADIUS * 2.5;
      const dSq = distanceSq(snake.headX, snake.headY, food.x, food.y);

      if (dSq < eatDist * eatDist) {
        eats.push({ snakeId, foodId });
      }
    }
  }

  return eats;
}
