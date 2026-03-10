import { IVoiceChat, VoicePeer, VoiceChatCallbacks } from "./VoiceChat";

/**
 * Mock voice chat for testing UI without a real provider.
 * Simulates bots "talking" on random intervals.
 */
export class MockVoiceChat implements IVoiceChat {
  private peers = new Map<string, VoicePeer>();
  private callbacks: VoiceChatCallbacks | null = null;
  private selfMuted = false;
  private mySessionId = "";
  private talkInterval: ReturnType<typeof setInterval> | null = null;
  private joined = false;

  async join(roomId: string, sessionId: string, name: string): Promise<void> {
    this.mySessionId = sessionId;
    this.joined = true;

    // Simulate random bot talking every 2-5 seconds
    this.talkInterval = setInterval(() => {
      if (!this.joined) return;
      const peerIds = Array.from(this.peers.keys()).filter(id => id !== this.mySessionId);
      if (peerIds.length === 0) return;

      const randomId = peerIds[Math.floor(Math.random() * peerIds.length)];
      const peer = this.peers.get(randomId);
      if (!peer || peer.isMuted) return;

      // Start talking
      peer.isTalking = true;
      this.callbacks?.onTalkingChanged(randomId, true);

      // Stop talking after 1-3 seconds
      const duration = 1000 + Math.random() * 2000;
      setTimeout(() => {
        const p = this.peers.get(randomId);
        if (p) {
          p.isTalking = false;
          this.callbacks?.onTalkingChanged(randomId, false);
        }
      }, duration);
    }, 2000 + Math.random() * 3000);
  }

  leave(): void {
    this.joined = false;
    this.peers.clear();
    if (this.talkInterval) {
      clearInterval(this.talkInterval);
      this.talkInterval = null;
    }
  }

  muteSelf(): void {
    this.selfMuted = true;
  }

  unmuteSelf(): void {
    this.selfMuted = false;
  }

  mutePeer(sessionId: string): void {
    const peer = this.peers.get(sessionId);
    if (peer) {
      peer.isMutedByMe = true;
      peer.isTalking = false;
    }
  }

  unmutePeer(sessionId: string): void {
    const peer = this.peers.get(sessionId);
    if (peer) peer.isMutedByMe = false;
  }

  setPeerVolume(sessionId: string, volume: number): void {
    const peer = this.peers.get(sessionId);
    if (peer) peer.volume = Math.max(0, Math.min(1, volume));
  }

  isSelfMuted(): boolean {
    return this.selfMuted;
  }

  getPeers(): Map<string, VoicePeer> {
    return this.peers;
  }

  setCallbacks(cb: VoiceChatCallbacks): void {
    this.callbacks = cb;
  }

  /**
   * Sync peers from the game's alive snakes.
   * Called externally by the hook when snake list changes.
   */
  syncPeers(snakes: Map<string, { name: string; alive: boolean }>, mySessionId: string): void {
    // Add new peers
    for (const [id, snake] of snakes) {
      if (id === mySessionId || !snake.alive) continue;
      if (!this.peers.has(id)) {
        const peer: VoicePeer = {
          sessionId: id,
          name: snake.name,
          isTalking: false,
          isMuted: false,
          isMutedByMe: false,
          volume: 1.0,
        };
        this.peers.set(id, peer);
        this.callbacks?.onPeerJoined(peer);
      }
    }

    // Remove departed peers
    for (const [id] of this.peers) {
      const snake = snakes.get(id);
      if (!snake || !snake.alive) {
        this.peers.delete(id);
        this.callbacks?.onPeerLeft(id);
      }
    }
  }

  destroy(): void {
    this.leave();
    this.callbacks = null;
  }
}
