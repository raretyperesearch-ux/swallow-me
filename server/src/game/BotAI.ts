import { ServerSnake } from "./Snake";
import { ServerFood } from "./Food";
import { GAME_CONFIG } from "../config/gameConfig";

export type BotType = "hunter" | "patrol" | "coward";

const BOT_NAMES = [
  "VIPER", "FANG", "COBRA", "MAMBA", "PYTHON",
  "REAPER", "GHOST", "SHADOW", "BLADE", "STORM",
  "TITAN", "APEX", "RAZOR", "FURY", "OMEGA",
];

export function getRandomBotName(): string {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

export function getRandomBotType(): BotType {
  const roll = Math.random();
  if (roll < 0.40) return "hunter";
  if (roll < 0.80) return "patrol";
  return "coward";
}

interface BotState {
  botType: BotType;
  targetX: number;
  targetY: number;
  decisionTimer: number;

  // Wobble (natural movement)
  wobbleOffset: number;
  wobbleTimer: number;

  // Patrol chase mode
  chaseTarget: string | null;
  chaseTimer: number; // ticks remaining (10s = 300 ticks at 30Hz)

  // Hunter retreat/cooldown
  huntStartTime: number;      // when current hunt began
  huntTargetId: string | null; // who we're hunting
  retreatTimer: number;        // ticks remaining in retreat mode
  huntCooldowns: Map<string, number>; // playerId → timestamp when cooldown expires

  // Swerve direction (consistent per encounter)
  swerveDir: number; // +1 or -1
}

const botStates = new Map<string, BotState>();

export function initBotState(id: string, botType?: BotType): void {
  botStates.set(id, {
    botType: botType || getRandomBotType(),
    targetX: 0,
    targetY: 0,
    decisionTimer: 0,
    wobbleOffset: 0,
    wobbleTimer: 0,
    chaseTarget: null,
    chaseTimer: 0,
    huntStartTime: 0,
    huntTargetId: null,
    retreatTimer: 0,
    huntCooldowns: new Map(),
    swerveDir: Math.random() > 0.5 ? 1 : -1,
  });
}

export function removeBotState(id: string): void {
  botStates.delete(id);
}

export function getBotState(id: string): BotState | undefined {
  return botStates.get(id);
}

// ─── Helpers ────────────────────────────────────────────

function distSq(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return dx * dx + dy * dy;
}

function dist(x1: number, y1: number, x2: number, y2: number): number {
  return Math.sqrt(distSq(x1, y1, x2, y2));
}

function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

function findNearestPlayer(
  bot: ServerSnake,
  allSnakes: Map<string, ServerSnake>,
  maxDist: number,
  excludeIds?: Set<string>,
): { snake: ServerSnake; dist: number } | null {
  let nearest: ServerSnake | null = null;
  let nearestDistSq = maxDist * maxDist;

  for (const [id, other] of allSnakes) {
    if (id === bot.id || !other.alive || other.isBot) continue;
    if (excludeIds && excludeIds.has(id)) continue;
    const d = distSq(bot.headX, bot.headY, other.headX, other.headY);
    if (d < nearestDistSq) {
      nearestDistSq = d;
      nearest = other;
    }
  }

  return nearest ? { snake: nearest, dist: Math.sqrt(nearestDistSq) } : null;
}

function wouldHitOwnTail(bot: ServerSnake, angle: number, lookAhead: number): boolean {
  const futureX = bot.headX + Math.cos(angle) * lookAhead;
  const futureY = bot.headY + Math.sin(angle) * lookAhead;

  for (let i = 10; i < bot.segments.length; i += 3) {
    const seg = bot.segments[i];
    if (distSq(futureX, futureY, seg.x, seg.y) < 400) return true;
  }
  return false;
}

function steerTowardCenter(bot: ServerSnake, arenaRadius: number): number | null {
  const distFromCenter = Math.sqrt(bot.headX * bot.headX + bot.headY * bot.headY);
  if (distFromCenter > arenaRadius - 200) {
    return Math.atan2(-bot.headY, -bot.headX);
  }
  return null;
}

function isNearWall(x: number, y: number, arenaRadius: number, margin: number): boolean {
  return Math.sqrt(x * x + y * y) > arenaRadius - margin;
}

// Check if a player is moving toward a bot's body (for trap detection)
function isPlayerMovingTowardBody(
  player: ServerSnake,
  bot: ServerSnake,
): boolean {
  // Check if any of the bot's body segments are roughly in front of the player
  const playerDirX = Math.cos(player.angle);
  const playerDirY = Math.sin(player.angle);

  for (let i = 5; i < bot.segments.length; i += 5) {
    const seg = bot.segments[i];
    const toSegX = seg.x - player.headX;
    const toSegY = seg.y - player.headY;
    const segDist = Math.sqrt(toSegX * toSegX + toSegY * toSegY);
    if (segDist > 500 || segDist < 50) continue;

    // Dot product — is the segment in front of the player?
    const dot = (toSegX / segDist) * playerDirX + (toSegY / segDist) * playerDirY;
    if (dot > 0.7) return true; // within ~45 degree cone ahead
  }
  return false;
}

// ─── Anti-kamikaze check ────────────────────────────────

function antiKamikazeAngle(
  bot: ServerSnake,
  target: ServerSnake,
  desiredAngle: number,
  swerveDir: number,
): { angle: number; swerved: boolean } {
  const angleToHead = Math.atan2(
    target.headY - bot.headY,
    target.headX - bot.headX,
  );
  const angleDiff = Math.abs(normalizeAngle(desiredAngle - angleToHead));
  const headDist = dist(bot.headX, bot.headY, target.headX, target.headY);

  // If heading directly at their head (within 30°) and close, SWERVE
  if (angleDiff < Math.PI / 6 && headDist < 300) {
    return {
      angle: desiredAngle + swerveDir * (Math.PI / 3),
      swerved: true,
    };
  }
  return { angle: desiredAngle, swerved: false };
}

// ─── Max turn rate limiter (smooth turns, no U-turns) ───

const MAX_TURN_PER_TICK = 0.087; // ~5 degrees per tick

function clampTurn(currentAngle: number, desiredAngle: number): number {
  let diff = normalizeAngle(desiredAngle - currentAngle);
  if (Math.abs(diff) > MAX_TURN_PER_TICK) {
    diff = Math.sign(diff) * MAX_TURN_PER_TICK;
  }
  return currentAngle + diff;
}

// ─── Main Bot Update ────────────────────────────────────

export function updateBotInput(
  bot: ServerSnake,
  allSnakes: Map<string, ServerSnake>,
  allFood: Map<string, ServerFood>,
  arenaRadius: number
): { angle: number; boost: boolean } {
  let state = botStates.get(bot.id);
  if (!state) {
    initBotState(bot.id, (bot.botType as BotType) || undefined);
    state = botStates.get(bot.id)!;
  }

  const now = Date.now();
  let boost = false;
  let rawAngle: number;

  // Priority 1: Edge avoidance
  const edgeAngle = steerTowardCenter(bot, arenaRadius);
  if (edgeAngle !== null) {
    return { angle: clampTurn(bot.angle, edgeAngle), boost: false };
  }

  // Update wobble
  state.wobbleTimer--;
  if (state.wobbleTimer <= 0) {
    state.wobbleTimer = 10 + Math.floor(Math.random() * 20);
    const isChasing = state.chaseTimer > 0 || (state.botType === "hunter" && state.retreatTimer <= 0 && state.huntTargetId);
    const wobbleRange = isChasing ? 0.087 : 0.26; // ±5° chasing, ±15° normally
    state.wobbleOffset = (Math.random() - 0.5) * 2 * wobbleRange;
  }

  // Clean up expired hunt cooldowns
  for (const [pid, expiry] of state.huntCooldowns) {
    if (now > expiry) state.huntCooldowns.delete(pid);
  }

  state.decisionTimer--;

  switch (state.botType) {
    case "hunter":
      ({ angle: rawAngle, boost } = updateHunter(bot, state, allSnakes, allFood, arenaRadius, now));
      break;
    case "patrol":
      ({ angle: rawAngle, boost } = updatePatrol(bot, state, allSnakes, allFood, arenaRadius, now));
      break;
    case "coward":
      ({ angle: rawAngle, boost } = updateCoward(bot, state, allSnakes, allFood, arenaRadius));
      break;
    default:
      rawAngle = bot.angle;
  }

  // Self-tail avoidance
  const lookAhead = bot.boosting ? 80 : 50;
  let finalAngle = rawAngle + state.wobbleOffset;
  if (wouldHitOwnTail(bot, finalAngle, lookAhead)) {
    const deflect = Math.PI / 3;
    if (!wouldHitOwnTail(bot, finalAngle + deflect, lookAhead)) {
      finalAngle += deflect;
    } else if (!wouldHitOwnTail(bot, finalAngle - deflect, lookAhead)) {
      finalAngle -= deflect;
    }
  }

  // Apply max turn rate (smooth turns)
  finalAngle = clampTurn(bot.angle, finalAngle);

  return { angle: finalAngle, boost };
}

// ─── HUNTER: Circle & cut off, retreat on failure ───────

function updateHunter(
  bot: ServerSnake,
  state: BotState,
  allSnakes: Map<string, ServerSnake>,
  allFood: Map<string, ServerFood>,
  arenaRadius: number,
  now: number,
): { angle: number; boost: boolean } {
  // If in retreat mode, move away from last target
  if (state.retreatTimer > 0) {
    state.retreatTimer--;
    if (state.retreatTimer <= 0) {
      state.huntTargetId = null;
    }
    // Move in current direction (away from failed hunt)
    if (state.decisionTimer <= 0) {
      state.decisionTimer = 30;
      setFoodTarget(state, bot, allFood);
    }
    return {
      angle: Math.atan2(state.targetY - bot.headY, state.targetX - bot.headX),
      boost: false,
    };
  }

  // Build set of cooled-down players to exclude
  const excludeIds = new Set<string>();
  for (const [pid, expiry] of state.huntCooldowns) {
    if (now < expiry) excludeIds.add(pid);
  }

  // Look for nearest player within 800 units (excluding cooled-down targets)
  const target = findNearestPlayer(bot, allSnakes, 800, excludeIds);

  if (target) {
    // Track hunt duration
    if (state.huntTargetId !== target.snake.id) {
      state.huntTargetId = target.snake.id;
      state.huntStartTime = now;
    }

    // Check if hunt has gone on too long (3 seconds) without a kill — RETREAT
    if (now - state.huntStartTime > 3000 && target.dist < 200) {
      // Failed attack — disengage
      state.retreatTimer = 150; // 5 seconds at 30Hz
      state.huntCooldowns.set(target.snake.id, now + 10000); // 10s cooldown on this player

      // Turn away
      const awayAngle = Math.atan2(
        bot.headY - target.snake.headY,
        bot.headX - target.snake.headX,
      );
      state.targetX = bot.headX + Math.cos(awayAngle) * 500;
      state.targetY = bot.headY + Math.sin(awayAngle) * 500;

      return { angle: awayAngle, boost: true };
    }

    // Calculate intercept point — aim AHEAD of where the player is going
    const playerVelX = Math.cos(target.snake.angle) * target.snake.speed;
    const playerVelY = Math.sin(target.snake.angle) * target.snake.speed;
    const interceptTime = Math.min(target.dist / 16, 45); // ticks ahead (1.5s max)
    const interceptX = target.snake.headX + playerVelX * interceptTime;
    const interceptY = target.snake.headY + playerVelY * interceptTime;

    // If far away (> 400), approach at an offset (flanking)
    let targetAngle: number;
    if (target.dist > 400) {
      // Move to a point offset from the player (flanking approach)
      const perpAngle = target.snake.angle + state.swerveDir * (Math.PI / 2);
      const offsetX = interceptX + Math.cos(perpAngle) * 150;
      const offsetY = interceptY + Math.sin(perpAngle) * 150;
      targetAngle = Math.atan2(offsetY - bot.headY, offsetX - bot.headX);
    } else {
      // Close enough — go for the cut-off
      targetAngle = Math.atan2(interceptY - bot.headY, interceptX - bot.headX);
    }

    // Anti-kamikaze: swerve if heading directly at their head
    const { angle: safeAngle } = antiKamikazeAngle(bot, target.snake, targetAngle, state.swerveDir);

    // Only boost during the actual cut-off move (< 400 units), not the approach
    const boost = target.dist < 400 && bot.length > GAME_CONFIG.MIN_BOOST_LENGTH;

    return { angle: safeAngle, boost };
  }

  // No player nearby — roam toward food
  state.huntTargetId = null;
  if (state.decisionTimer <= 0) {
    state.decisionTimer = 20 + Math.floor(Math.random() * 30);
    setFoodTarget(state, bot, allFood);
  }

  return {
    angle: Math.atan2(state.targetY - bot.headY, state.targetX - bot.headX),
    boost: false,
  };
}

// ─── PATROL: Wide roam, chase if close, set traps ───────

function updatePatrol(
  bot: ServerSnake,
  state: BotState,
  allSnakes: Map<string, ServerSnake>,
  allFood: Map<string, ServerFood>,
  arenaRadius: number,
  now: number,
): { angle: number; boost: boolean } {
  let boost = false;

  // Check for trap opportunity: player approaching our body from behind
  for (const [id, other] of allSnakes) {
    if (id === bot.id || !other.alive || other.isBot) continue;
    const playerDist = dist(bot.headX, bot.headY, other.headX, other.headY);
    if (playerDist < 500 && other.speed > bot.speed * 0.8) {
      if (isPlayerMovingTowardBody(other, bot)) {
        // TRAP: slow down / hold position — let them run into our body
        // Return current angle with no change (effectively "stop turning")
        return { angle: bot.angle, boost: false };
      }
    }
  }

  // Chase mode
  if (state.chaseTimer > 0) {
    state.chaseTimer--;

    const chaseTarget = state.chaseTarget ? allSnakes.get(state.chaseTarget) : null;
    if (chaseTarget && chaseTarget.alive) {
      const dx = chaseTarget.headX - bot.headX;
      const dy = chaseTarget.headY - bot.headY;
      const chaseDist = Math.sqrt(dx * dx + dy * dy);

      // Use intercept prediction
      const interceptTime = Math.min(chaseDist / 16, 36);
      const predictX = chaseTarget.headX + Math.cos(chaseTarget.angle) * chaseTarget.speed * interceptTime;
      const predictY = chaseTarget.headY + Math.sin(chaseTarget.angle) * chaseTarget.speed * interceptTime;
      let targetAngle = Math.atan2(predictY - bot.headY, predictX - bot.headX);

      // Anti-kamikaze
      const { angle: safeAngle } = antiKamikazeAngle(bot, chaseTarget, targetAngle, state.swerveDir);
      boost = chaseDist < 400 && bot.length > GAME_CONFIG.MIN_BOOST_LENGTH;

      return { angle: safeAngle, boost };
    } else {
      state.chaseTimer = 0;
      state.chaseTarget = null;
    }
  }

  // Check if a player is within 500 units — enter chase mode (10 seconds)
  const nearby = findNearestPlayer(bot, allSnakes, 500);
  if (nearby) {
    state.chaseTimer = 300;
    state.chaseTarget = nearby.snake.id;

    const targetAngle = Math.atan2(
      nearby.snake.headY - bot.headY,
      nearby.snake.headX - bot.headX,
    );
    return { angle: targetAngle, boost: false };
  }

  // Normal patrol — wider roaming patterns
  if (state.decisionTimer <= 0) {
    state.decisionTimer = 40 + Math.floor(Math.random() * 60);

    if (Math.random() < 0.5) {
      setFoodTarget(state, bot, allFood);
    } else {
      const wanderAngle = bot.angle + (Math.random() - 0.5) * 1.2;
      const wanderDist = 400 + Math.random() * 400;
      state.targetX = bot.headX + Math.cos(wanderAngle) * wanderDist;
      state.targetY = bot.headY + Math.sin(wanderAngle) * wanderDist;
    }
  }

  return {
    angle: Math.atan2(state.targetY - bot.headY, state.targetX - bot.headX),
    boost: false,
  };
}

// ─── COWARD: Collect food, flee smartly, dodge walls ────

function updateCoward(
  bot: ServerSnake,
  state: BotState,
  allSnakes: Map<string, ServerSnake>,
  allFood: Map<string, ServerFood>,
  arenaRadius: number,
): { angle: number; boost: boolean } {
  const threat = findNearestPlayer(bot, allSnakes, 600);

  if (threat) {
    // Flee direction
    let fleeAngle = Math.atan2(
      bot.headY - threat.snake.headY,
      bot.headX - threat.snake.headX,
    );

    // Wall dodge: if fleeing toward a wall, turn perpendicular
    const fleeX = bot.headX + Math.cos(fleeAngle) * 300;
    const fleeY = bot.headY + Math.sin(fleeAngle) * 300;
    if (isNearWall(fleeX, fleeY, arenaRadius, 300)) {
      // Turn 90 degrees to slip past the player instead of hitting the wall
      fleeAngle += state.swerveDir * (Math.PI / 2);
    }

    // If player is close AND wall is close, try to slip PAST
    if (threat.dist < 300 && isNearWall(bot.headX, bot.headY, arenaRadius, 200)) {
      // Go perpendicular to the line between us and the threat
      const toThreat = Math.atan2(
        threat.snake.headY - bot.headY,
        threat.snake.headX - bot.headX,
      );
      fleeAngle = toThreat + state.swerveDir * (Math.PI / 2);
    }

    const boost = threat.dist < 300 && bot.length > GAME_CONFIG.MIN_BOOST_LENGTH;
    return { angle: fleeAngle, boost };
  }

  // Safe — collect food
  if (state.decisionTimer <= 0) {
    state.decisionTimer = 25 + Math.floor(Math.random() * 40);
    setFoodTarget(state, bot, allFood);
  }

  return {
    angle: Math.atan2(state.targetY - bot.headY, state.targetX - bot.headX),
    boost: false,
  };
}

// ─── Food Targeting ─────────────────────────────────────

function setFoodTarget(
  state: BotState,
  bot: ServerSnake,
  allFood: Map<string, ServerFood>
): void {
  let nearestFood: ServerFood | null = null;
  let nearestDist = Infinity;

  for (const [, food] of allFood) {
    const dx = food.x - bot.headX;
    const dy = food.y - bot.headY;
    const d = dx * dx + dy * dy;
    const adjusted = food.size === 2 ? d * 0.5 : d;
    if (adjusted < nearestDist) {
      nearestDist = adjusted;
      nearestFood = food;
    }
  }

  if (nearestFood) {
    state.targetX = nearestFood.x;
    state.targetY = nearestFood.y;
  } else {
    const wanderAngle = Math.random() * Math.PI * 2;
    state.targetX = bot.headX + Math.cos(wanderAngle) * 200;
    state.targetY = bot.headY + Math.sin(wanderAngle) * 200;
  }
}
