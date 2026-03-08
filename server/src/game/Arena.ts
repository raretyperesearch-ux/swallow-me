import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake } from "./Snake";

/**
 * Find a safe spawn position away from existing snakes
 */
export function findSafeSpawn(
  existingSnakes: Map<string, ServerSnake>,
  arenaRadius: number,
  attempts: number = 20
): { x: number; y: number } {
  const minDistFromSnake = 200;
  const spawnZone = arenaRadius * 0.7; // Don't spawn too close to edge

  for (let i = 0; i < attempts; i++) {
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * spawnZone;
    const x = Math.cos(angle) * dist;
    const y = Math.sin(angle) * dist;

    let safe = true;
    for (const [, snake] of existingSnakes) {
      if (!snake.alive) continue;
      const dx = x - snake.headX;
      const dy = y - snake.headY;
      if (dx * dx + dy * dy < minDistFromSnake * minDistFromSnake) {
        safe = false;
        break;
      }
    }

    if (safe) return { x, y };
  }

  // Fallback: random position
  const angle = Math.random() * Math.PI * 2;
  const dist = Math.random() * spawnZone;
  return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist };
}
