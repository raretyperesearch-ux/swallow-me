import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake } from "./Snake";
import { ServerFood } from "./Food";

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
 * Check all head-to-body collisions between snakes.
 * Returns kill events for this tick.
 */
export function checkSnakeCollisions(
  snakes: Map<string, ServerSnake>
): KillEvent[] {
  const kills: KillEvent[] = [];
  const alreadyDead = new Set<string>();

  for (const [id, snake] of snakes) {
    if (!snake.alive || alreadyDead.has(id)) continue;

    const headX = snake.headX;
    const headY = snake.headY;

    // Check this snake's head against all other snakes' bodies
    for (const [otherId, other] of snakes) {
      if (otherId === id || !other.alive || alreadyDead.has(otherId)) continue;

      // Skip first few segments of other snake (head area, prevent self-like kills)
      const startSeg = 5;
      for (let i = startSeg; i < other.segments.length; i++) {
        const seg = other.segments[i];
        const collisionDist = GAME_CONFIG.HEAD_RADIUS + GAME_CONFIG.BODY_RADIUS;
        const dSq = distanceSq(headX, headY, seg.x, seg.y);

        if (dSq < collisionDist * collisionDist) {
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

  // Head-to-head: both die (lower value goes to food, not a "kill")
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
        // Both die — treated as wall deaths (no killer gets credit)
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
 */
export function checkFoodCollisions(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>
): FoodEatEvent[] {
  const eats: FoodEatEvent[] = [];

  for (const [snakeId, snake] of snakes) {
    if (!snake.alive) continue;

    for (const [foodId, food] of foods) {
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
