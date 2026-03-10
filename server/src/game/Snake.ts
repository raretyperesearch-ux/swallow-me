import { GAME_CONFIG } from "../config/gameConfig";

export interface SnakeSegmentData {
  x: number;
  y: number;
}

export interface ServerSnake {
  id: string;
  name: string;
  wallet: string;
  headX: number;
  headY: number;
  prevHeadX: number;
  prevHeadY: number;
  angle: number;
  targetAngle: number;
  speed: number;
  boosting: boolean;
  length: number;
  segments: SnakeSegmentData[];
  alive: boolean;
  isBot: boolean;
  valueUsdc: number; // USDC lamports
  kills: number;
  skinId: number;
  lastInputTime: number;
  spawnTime: number;
}

export function createSnake(
  id: string,
  name: string,
  wallet: string,
  spawnX: number,
  spawnY: number,
  valueUsdc: number,
  isBot: boolean = false,
  skinId: number = 0
): ServerSnake {
  const angle = Math.random() * Math.PI * 2;
  const segments: SnakeSegmentData[] = [];

  // Create initial body segments behind the head
  for (let i = 0; i < GAME_CONFIG.INITIAL_LENGTH; i++) {
    segments.push({
      x: spawnX - Math.cos(angle) * i * GAME_CONFIG.SEGMENT_SPACING,
      y: spawnY - Math.sin(angle) * i * GAME_CONFIG.SEGMENT_SPACING,
    });
  }

  return {
    id,
    name,
    wallet,
    headX: spawnX,
    headY: spawnY,
    prevHeadX: spawnX,
    prevHeadY: spawnY,
    angle,
    targetAngle: angle,
    speed: GAME_CONFIG.BASE_SPEED,
    boosting: false,
    length: GAME_CONFIG.INITIAL_LENGTH,
    segments,
    alive: true,
    isBot,
    valueUsdc,
    kills: 0,
    skinId,
    lastInputTime: Date.now(),
    spawnTime: Date.now(),
  };
}

export function updateSnake(snake: ServerSnake): void {
  if (!snake.alive) return;

  // Smooth turning toward target angle
  let angleDiff = snake.targetAngle - snake.angle;

  // Normalize to [-PI, PI]
  while (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
  while (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

  // Minimum turn radius scales with size — bigger snakes turn wider
  // v = ω * r → ω = v / r. Clamp turn rate to enforce minimum circle radius.
  const minRadius = GAME_CONFIG.MIN_TURN_RADIUS + snake.length * GAME_CONFIG.TURN_RADIUS_SCALE;
  const currentSpeed = snake.boosting ? GAME_CONFIG.BOOST_SPEED : GAME_CONFIG.BASE_SPEED;
  const maxTurnRate = currentSpeed / minRadius;
  const effectiveTurnRate = Math.min(GAME_CONFIG.TURN_RATE, maxTurnRate);

  // Apply turn rate limit
  if (Math.abs(angleDiff) > effectiveTurnRate) {
    snake.angle += Math.sign(angleDiff) * effectiveTurnRate;
  } else {
    snake.angle = snake.targetAngle;
  }

  // Set speed based on boost
  if (snake.boosting && snake.length > GAME_CONFIG.MIN_BOOST_LENGTH) {
    snake.speed = GAME_CONFIG.BOOST_SPEED;
    // Lose length while boosting (drops food behind)
    snake.length = Math.max(
      GAME_CONFIG.MIN_BOOST_LENGTH,
      snake.length - GAME_CONFIG.BOOST_LENGTH_COST
    );
  } else {
    snake.speed = GAME_CONFIG.BASE_SPEED;
    snake.boosting = false;
  }

  // Save previous position for swept collision detection
  snake.prevHeadX = snake.headX;
  snake.prevHeadY = snake.headY;

  // Move head
  snake.headX += Math.cos(snake.angle) * snake.speed;
  snake.headY += Math.sin(snake.angle) * snake.speed;

  // Add new head position to front of segments
  snake.segments.unshift({ x: snake.headX, y: snake.headY });

  // Trim segments to match length
  const targetSegments = Math.floor(snake.length);
  while (snake.segments.length > targetSegments) {
    snake.segments.pop();
  }
}

export function growSnake(snake: ServerSnake, amount: number): void {
  snake.length = Math.min(snake.length + amount, GAME_CONFIG.MAX_LENGTH);
}
