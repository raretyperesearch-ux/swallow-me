// Game tuning parameters — tweak these to balance gameplay

export const GAME_CONFIG = {
  // Tick rate
  TICK_RATE: 60, // Server updates per second
  CLIENT_SEND_RATE: 20, // How often clients send input (throttled)

  // Arena
  ARENA_RADIUS: 3000, // Circular map radius in game units
  BOUNDARY_KILL: true, // Die when hitting the wall

  // Snake movement
  BASE_SPEED: 4.5, // Normal movement speed (units per tick)
  BOOST_SPEED: 9.0, // Speed while boosting
  TURN_RATE: 0.04, // Max radians per tick the snake can turn (wide arcs)
  BOOST_LENGTH_COST: 0.3, // Length units lost per tick while boosting
  MIN_BOOST_LENGTH: 15, // Can't boost below this length

  // Snake sizing
  INITIAL_LENGTH: 50, // Starting snake length (segments)
  MAX_LENGTH: 500, // Cap to prevent perf issues
  SEGMENT_SPACING: 4, // Distance between body segments
  HEAD_RADIUS: 14, // Collision radius of the head
  BODY_RADIUS: 12, // Collision radius of body segments

  // Food
  INITIAL_FOOD_COUNT: 500, // Food orbs at game start
  MAX_FOOD: 800, // Cap on total food
  FOOD_VALUE: 1.0, // Length gained per food eaten
  DEATH_FOOD_COUNT: 25, // Food orbs dropped on death
  FOOD_SPAWN_RATE: 3, // New food per second (natural spawning)

  // Lobby
  MIN_PLAYERS_TO_START: 3, // Real + bots needed
  BOT_FILL_TARGET: 5, // Fill lobby to this many total with bots
  MAX_PLAYERS: {
    1: 25, // $1 tier
    5: 20, // $5 tier
    20: 15, // $20 tier
  } as Record<number, number>,
};

export const TIER_CONFIG = {
  1: {
    entryAmount: 1_000_000, // 1 USDC (6 decimals)
    rakeBps: 800, // 8%
    maxPlayers: 25,
  },
  5: {
    entryAmount: 5_000_000, // 5 USDC
    rakeBps: 800,
    maxPlayers: 20,
  },
  20: {
    entryAmount: 20_000_000, // 20 USDC
    rakeBps: 800,
    maxPlayers: 15,
  },
} as Record<number, { entryAmount: number; rakeBps: number; maxPlayers: number }>;

export const SOLANA_CONFIG = {
  USDC_MINT: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  TREASURY: process.env.TREASURY_PUBKEY || "53Qy2ygocLjKWbtjgaepzHfZnf9oiZENJPWMnNUkSz8L",
  PROGRAM_ID: process.env.PROGRAM_ID || "",
  RPC_URL: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
};
