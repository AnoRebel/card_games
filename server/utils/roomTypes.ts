/**
 * Shared room/realtime protocol types (server side).
 *
 * Messages travel over the Conduit WS connection. The server is authoritative:
 * it validates every move through the engine reducer and broadcasts redacted
 * state per recipient (no hidden-hand leaks).
 */
import type { Seat } from '@card-games/engine-core'

export type SpectatorVisibility = 'public' | 'locked'

export type RoomPhase = 'lobby' | 'in-progress' | 'finished'

export interface RoomMember {
  /** Connection/client id. */
  clientId: string
  /** Stable player id (from the client's localStorage identity). */
  playerId: string
  name: string
  seat: Seat | null
  spectator: boolean
  connected: boolean
}

export interface RoomConfig {
  gameId: string
  /** Engine variant config (opaque to the room layer). */
  gameConfig: unknown
  maxPlayers: number
  minPlayers: number
  spectatorVisibility: SpectatorVisibility
  /** Passcode required to spectate a locked room (empty when public). */
  spectatorPasscode: string
}

/** Client → server messages. */
export type ClientMessage =
  | { t: 'join'; roomId: string; playerId: string; name: string; asSpectator?: boolean; spectatorPasscode?: string }
  | { t: 'leave'; roomId: string }
  | { t: 'take-seat'; roomId: string; seat: Seat }
  | { t: 'start'; roomId: string }
  | { t: 'end'; roomId: string }
  | { t: 'move'; roomId: string; move: unknown }
  | { t: 'chat'; roomId: string; body: string }
  | { t: 'set-visibility'; roomId: string; visibility: SpectatorVisibility; passcode?: string }

/** Server → client messages. */
export type ServerMessage =
  | { t: 'joined'; roomId: string; youAre: { clientId: string; seat: Seat | null; spectator: boolean }; isHost: boolean }
  | { t: 'denied'; reason: string }
  | { t: 'room'; room: RoomSnapshot }
  | { t: 'state'; state: unknown; legalMoves: unknown[]; scores: unknown | null }
  | { t: 'chat'; messages: ChatMessage[] }
  | { t: 'error'; message: string }

/** A public room listed in the spectate lobby (no secrets). */
export interface PublicRoomInfo {
  id: string
  gameId: string
  phase: RoomPhase
  seated: number
  spectators: number
  maxPlayers: number
  startedAt: string | null
}

export interface ChatMessage {
  id: string
  senderId: string
  senderName: string
  body: string
  at: string
}

/** Public room snapshot (no secrets like the passcode). */
export interface RoomSnapshot {
  id: string
  gameId: string
  phase: RoomPhase
  hostClientId: string | null
  members: RoomMember[]
  maxPlayers: number
  minPlayers: number
  spectatorVisibility: SpectatorVisibility
  startedAt: string | null
  endedAt: string | null
  /** Epoch ms by which a dropped seated player must reconnect (else auto-end). */
  disconnectGraceUntil?: number | null
}
