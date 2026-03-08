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
  name: string
): Promise<Colyseus.Room> {
  const c = getClient();
  const roomName = `snake_${tier}`;

  const room = await c.joinOrCreate(roomName, {
    wallet,
    name,
  });

  console.log(`[Colyseus] Joined room ${room.id} (tier $${tier})`);
  return room;
}

export function sendInput(room: Colyseus.Room, angle: number, boost: boolean) {
  room.send("input", { angle, boost });
}

export function sendCashout(room: Colyseus.Room) {
  room.send("cashout");
}
