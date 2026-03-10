export interface VoicePeer {
  sessionId: string;
  name: string;
  isTalking: boolean;
  isMuted: boolean;       // they muted themselves
  isMutedByMe: boolean;   // I muted them
  volume: number;          // 0-1 based on proximity
}

export interface VoiceChatCallbacks {
  onPeerJoined: (peer: VoicePeer) => void;
  onPeerLeft: (sessionId: string) => void;
  onTalkingChanged: (sessionId: string, isTalking: boolean) => void;
}

export interface IVoiceChat {
  join(roomId: string, sessionId: string, name: string): Promise<void>;
  leave(): void;
  muteSelf(): void;
  unmuteSelf(): void;
  mutePeer(sessionId: string): void;
  unmutePeer(sessionId: string): void;
  setPeerVolume(sessionId: string, volume: number): void;
  isSelfMuted(): boolean;
  getPeers(): Map<string, VoicePeer>;
  setCallbacks(cb: VoiceChatCallbacks): void;
  destroy(): void;
}
