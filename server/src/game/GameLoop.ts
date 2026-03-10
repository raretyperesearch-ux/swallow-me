import { GAME_CONFIG } from "../config/gameConfig";
import { ServerSnake, updateSnake, growSnake } from "./Snake";
import { ServerFood, spawnRandomFood, spawnDeathFood } from "./Food";
import {
  checkSnakeCollisions,
  checkBoundaryCollisions,
  checkFoodCollisions,
  checkContainmentKills,
  KillEvent,
  FoodEatEvent,
} from "./Physics";
import { updateBotInput } from "./BotAI";

export interface GameLoopCallbacks {
  onKill: (event: KillEvent) => void;
  onBoostFoodDrop: (x: number, y: number) => void;
  onFoodEaten: (eats: { foodId: string; snakeId: string }[]) => void;
  onFoodSpawned: (foods: ServerFood[]) => void;
}

export function runGameTick(
  snakes: Map<string, ServerSnake>,
  foods: Map<string, ServerFood>,
  arenaRadius: number,
  callbacks: GameLoopCallbacks
): void {
  // 1. Update bot inputs
  for (const [, snake] of snakes) {
    if (!snake.alive || !snake.isBot) continue;
    const input = updateBotInput(snake, snakes, foods, arenaRadius);
    snake.targetAngle = input.angle;
    snake.boosting = input.boost;
  }

  // 2. Move all snakes
  for (const [, snake] of snakes) {
    if (!snake.alive) continue;

    const wasBoosting = snake.boosting;
    const prevLength = snake.length;
    updateSnake(snake);

    // If boosting caused length loss, drop food behind tail (every 3rd tick)
    if (wasBoosting && snake.length < prevLength) {
      snake.boostTickCounter++;
      if (snake.boostTickCounter % 3 === 0) {
        const tail = snake.segments[snake.segments.length - 1];
        if (tail) {
          callbacks.onBoostFoodDrop(tail.x, tail.y);
        }
      }
    } else {
      snake.boostTickCounter = 0;
    }
  }

  // 3. Check collisions — run TWICE to catch edge cases where first pass
  //    marks a snake dead that was blocking detection of another collision
  const snakeKills1 = checkSnakeCollisions(snakes);
  const containmentKills = checkContainmentKills(snakes);
  const snakeKills2 = checkSnakeCollisions(snakes); // second pass catches stragglers
  const boundaryKills = checkBoundaryCollisions(snakes, arenaRadius);
  const allKills = [...snakeKills1, ...containmentKills, ...snakeKills2, ...boundaryKills];

  // 4. Process kills
  for (const kill of allKills) {
    const victim = snakes.get(kill.victim);
    if (victim && victim.alive) {
      victim.alive = false;

      // Drop death food along the victim's body shape
      const deathFoods = spawnDeathFood(
        victim.segments,
        GAME_CONFIG.DEATH_FOOD_COUNT
      );
      for (const f of deathFoods) {
        foods.set(f.id, f);
      }

      // Notify room of new death food for state sync
      callbacks.onFoodSpawned(deathFoods);

      // If there's a killer (not wall), credit the kill
      if (kill.killer) {
        const killer = snakes.get(kill.killer);
        if (killer && killer.alive) {
          killer.kills++;
        }
      }

      callbacks.onKill(kill);
    }
  }

  // 5. Check food consumption (uses spatial grid internally)
  const foodEats = checkFoodCollisions(snakes, foods);
  const eatenFoods: { foodId: string; snakeId: string }[] = [];
  for (const eat of foodEats) {
    const snake = snakes.get(eat.snakeId);
    const food = foods.get(eat.foodId);
    if (snake && food) {
      const growAmount = food.size === 2
        ? GAME_CONFIG.FOOD_VALUE * 3
        : GAME_CONFIG.FOOD_VALUE;
      growSnake(snake, growAmount);
      foods.delete(eat.foodId);
      eatenFoods.push({ foodId: eat.foodId, snakeId: eat.snakeId });
    }
  }

  // Notify clients of eaten food IDs for immediate removal
  if (eatenFoods.length > 0) {
    callbacks.onFoodEaten(eatenFoods);
  }

  // 6. Natural food spawning (maintain minimum)
  if (foods.size < GAME_CONFIG.INITIAL_FOOD_COUNT) {
    const toSpawn = Math.min(
      GAME_CONFIG.FOOD_SPAWN_RATE,
      GAME_CONFIG.MAX_FOOD - foods.size
    );
    const newFoods: ServerFood[] = [];
    for (let i = 0; i < toSpawn; i++) {
      const f = spawnRandomFood(arenaRadius);
      foods.set(f.id, f);
      newFoods.push(f);
    }
    if (newFoods.length > 0) {
      callbacks.onFoodSpawned(newFoods);
    }
  }
}
