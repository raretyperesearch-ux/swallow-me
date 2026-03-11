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

// Dynamic body radius — MUST match the client's visual radius formula
function getBodyRadius(segmentCount: number): number {
  return 6 + Math.pow(Math.max(1, segmentCount - 20), 0.35) * 3;
}

/**
 * Ray-casting containment test: is point (px,py) inside the polygon
 * formed by a snake's body segments? Uses crossing-number algorithm.
 */
function isPointInsideSnakeLoop(
  px: number, py: number,
  segments: { x: number; y: number }[],
  minSegments: number = 30
): boolean {
  const n = segments.length;
  if (n < minSegments) return false;

  const head = segments[0];
  const tail = segments[n - 1];
  const closeDist = 80;
  const dx = head.x - tail.x;
  const dy = head.y - tail.y;
  if (dx * dx + dy * dy > closeDist * closeDist) return false;

  let crossings = 0;
  for (let i = 0; i < n; i++) {
    const a = segments[i];
    const b = segments[(i + 1) % n];

    if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) {
      const t = (py - a.y) / (b.y - a.y);
      const ix = a.x + t * (b.x - a.x);
      if (px < ix) {
        crossings++;
      }
    }
  }

  return (crossings & 1) === 1;
}

// Spatial grid for food only — snake collision is brute force (airtight)
const foodGrid = new SpatialGrid(50);

/**
 * Check all head-to-body collisions between snakes.
 * BRUTE FORCE — no spatial grid, no skipping, no stride.
 * For 10-20 snakes this is fast enough and CANNOT miss.
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  // HEAD vs BODY: brute force — dynamic radius, no multiplier
  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;
    const headRadius = getBodyRadius(snake.segments.length);

    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      const otherBodyRadius = getBodyRadius(other.segments.length);
      const killDist = headRadius + otherBodyRadius;
      const killDistSq = killDist * killDist;

      // Check against EVERY body segment starting at index 1 (skip 0 which is the head position)
      for (let i = 1; i < other.segments.length; i++) {
        const seg = other.segments[i];
        const dx = headX - seg.x;
        const dy = headY - seg.y;
        const dSq = dx * dx + dy * dy;

        if (dSq < killDistSq) {
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

  // Head-to-head: bigger snake wins, same size = both die
  const heads = Array.from(snakes.entries()).filter(
    ([id, s]) => s.alive && !alreadyDead.has(id)
  );
  for (let i = 0; i < heads.length; i++) {
    for (let j = i + 1; j < heads.length; j++) {
      const [idA, a] = heads[i];
      const [idB, b] = heads[j];
      if (alreadyDead.has(idA) || alreadyDead.has(idB)) continue;

      const headCollDist = getBodyRadius(a.segments.length) + getBodyRadius(b.segments.length);
      const dSq = distanceSq(a.headX, a.headY, b.headX, b.headY);
      if (dSq < headCollDist * headCollDist) {
        if (a.length > b.length * 1.1) {
          kills.push({ killer: idA, victim: idB, victimValue: b.valueUsdc, victimName: b.name, killerName: a.name, timestamp: Date.now() });
          alreadyDead.add(idB);
        } else if (b.length > a.length * 1.1) {
          kills.push({ killer: idB, victim: idA, victimValue: a.valueUsdc, victimName: a.name, killerName: b.name, timestamp: Date.now() });
          alreadyDead.add(idA);
        } else {
          kills.push({ killer: null, victim: idA, victimValue: a.valueUsdc, victimName: a.name, killerName: "", timestamp: Date.now() });
          kills.push({ killer: null, victim: idB, victimValue: b.valueUsdc, victimName: b.name, killerName: "", timestamp: Date.now() });
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

    if (distFromCenter + getBodyRadius(snake.segments.length) >= arenaRadius) {
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
 */
export function checkFoodCollisions(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>
): FoodEatEvent[] {
  const eats: FoodEatEvent[] = [];
  const eaten = new Set<string>();

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
