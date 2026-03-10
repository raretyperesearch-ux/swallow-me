import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake } from "./Snake";

/**
 * Find a safe spawn position away from existing snakes.
 * - 500 units from every alive snake's head
 * - 300 units from body segments of snakes longer than 100
 * - 200 units from the arena boundary
 */
export function findSafeSpawn(
  existingSnakes: Map<string, ServerSnake>,
  arenaRadius: number,
  attempts: number = 50
): { x: number; y: number } {
  const minDistFromHead = 800;
  const minDistFromBody = 500;
  const minBodyLengthForCheck = 100;
  const wallBuffer = 300;
  const spawnZone = arenaRadius - wallBuffer;

  for (let i = 0; i < attempts; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * spawnZone;
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist;

    let safe = true;
    for (const [, snake] of existingSnakes) {
      if (!snake.alive) continue;

      // Check distance from head
      const dx = x - snake.headX;
      const dy = y - snake.headY;
      if (dx * dx + dy * dy < minDistFromHead * minDistFromHead) {
        safe = false;
        break;
      }

      // Check distance from body segments of big snakes
      if (snake.length >= minBodyLengthForCheck) {
        for (let s = 0; s < snake.segments.length; s += 5) {
          const seg = snake.segments[s];
          const bx = x - seg.x;
          const by = y - seg.y;
          if (bx * bx + by * by < minDistFromBody * minDistFromBody) {
            safe = false;
            break;
          }
        }
        if (!safe) break;
      }
    }

    if (safe) return { x, y };
  }

  // Fallback: spawn near edge away from center cluster
  const fallbackAngle = Math.random() * Math.PI * 2;
  const fallbackDist = spawnZone * 0.8;
  return {
    x: Math.cos(fallbackAngle) * fallbackDist,
    y: Math.sin(fallbackAngle) * fallbackDist,
  };
}
