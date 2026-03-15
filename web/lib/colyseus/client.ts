import * as Colyseus from "colyseus.js";

const SERVER_URL = process.env.NEXT_PUBLIC_GAME_SERVER_URL || "ws://localhost:2567";

let client: Colyseus.Client | null = null;

export function getClient(): Colyseus.Client {
  if (!client) {
    client = new Colyseus.Client(SERVER_URL);
  }
  return client;
}

export async function joinRoom(
  tier: number,
  wallet: string,
  name: string,
  extra?: { sessionId?: string; playerId?: string; guest?: boolean; spectate?: boolean }
): Promise<Colyseus.Room> {
  const c = getClient();
  const roomName = extra?.guest ? `snake_${tier}_free` : `snake_${tier}`;

  const room = await c.joinOrCreate(roomName, {
    wallet,
    name,
    ...extra,
  });

  const mode = extra?.spectate ? 'spectate' : extra?.guest ? 'guest' : `tier $${tier}`;
  console.log(`[Colyseus] Joined room ${room.id} (${mode})`);
  return room;
}

export function sendInput(room: Colyseus.Room, angle: number, boost: boolean) {
  room.send("input", { angle, boost });
}

export function sendCashout(room: Colyseus.Room) {
  room.send("cashout");
}
