/**
 * WsTransport — online play over the Nitro-native WebSocket endpoint (/_ws).
 *
 * Satisfies the same GameTransport interface as LocalTransport, so the table UI
 * is identical online and offline. The server is authoritative: this transport
 * sends intents (join/move/chat) and renders the redacted state it receives.
 */
import type {
  BaseGameState,
  BaseMove,
  Player,
  ScoreResult,
  Seat,
} from '@card-games/engine-core'
import type {
  ChatMessage,
  GameTransport,
  PresenceInfo,
  TransportView,
} from './types'

interface ServerStateMsg {
  t: 'state'
  state: BaseGameState
  legalMoves: BaseMove[]
  scores: ScoreResult | null
}
interface ServerRoomMsg {
  t: 'room'
  room: {
    members: {
      clientId: string
      playerId: string
      name: string
      seat: Seat | null
      spectator: boolean
      connected: boolean
    }[]
    hostClientId: string | null
    spectatorVisibility?: 'public' | 'locked'
    phase?: 'lobby' | 'in-progress' | 'finished'
    minPlayers?: number
    maxPlayers?: number
  }
}

/** Reactive-friendly room metadata exposed to the UI. */
export interface RoomInfo {
  isHost: boolean
  amSpectator: boolean
  visibility: 'public' | 'locked'
  phase: 'lobby' | 'in-progress' | 'finished'
  seated: number
  here: number
  minPlayers: number
  maxPlayers: number
  /** Snapshot version, bumped on every room update for reactivity. */
  rev: number
}
type ServerMsg =
  | ServerStateMsg
  | ServerRoomMsg
  | { t: 'joined'; youAre: { clientId: string; seat: Seat | null; spectator: boolean }; isHost: boolean }
  | { t: 'denied'; reason: string }
  | { t: 'chat'; messages: ChatMessage[] }
  | { t: 'error'; message: string }

export interface WsTransportOptions {
  roomId: string
  playerId: string
  name: string
  asSpectator?: boolean
  spectatorPasscode?: string
  /** ws url; defaults to same-origin /_ws. */
  url?: string
}

export class WsTransport<S extends BaseGameState, M extends BaseMove>
  implements GameTransport<S, M>
{
  readonly mode = 'online' as const
  viewerSeat: Seat | null = null

  private ws: WebSocket | null = null
  private opts: WsTransportOptions
  private view: TransportView<S, M> | null = null
  private chat: ChatMessage[] = []
  private presence: PresenceInfo[] = []
  private players: Player[] = []
  private hostClientId: string | null = null
  private myClientId: string | null = null
  private amSpectator = false
  private roomInfo: RoomInfo = {
    isHost: false,
    amSpectator: false,
    visibility: 'public',
    phase: 'lobby',
    seated: 0,
    here: 0,
    minPlayers: 2,
    maxPlayers: 6,
    rev: 0,
  }

  private changeCbs = new Set<(v: TransportView<S, M>) => void>()
  private presenceCbs = new Set<() => void>()
  private chatCbs = new Set<(m: ChatMessage[]) => void>()
  private deniedCb?: (reason: string) => void
  private errorCb?: (msg: string) => void

  constructor(opts: WsTransportOptions) {
    this.opts = opts
    this.connect()
  }

  onDenied(cb: (reason: string) => void) {
    this.deniedCb = cb
  }
  onError(cb: (msg: string) => void) {
    this.errorCb = cb
  }
  get isHost() {
    return this.myClientId !== null && this.myClientId === this.hostClientId
  }

  private wsUrl(): string {
    if (this.opts.url) return this.opts.url
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    return `${proto}://${location.host}/_ws`
  }

  private connect() {
    const ws = new WebSocket(this.wsUrl())
    this.ws = ws
    ws.addEventListener('open', () => {
      this.sendRaw({
        t: 'join',
        roomId: this.opts.roomId,
        playerId: this.opts.playerId,
        name: this.opts.name,
        asSpectator: this.opts.asSpectator,
        spectatorPasscode: this.opts.spectatorPasscode,
      })
    })
    ws.addEventListener('message', (e) => this.onMessage(String(e.data)))
  }

  private onMessage(raw: string) {
    let msg: ServerMsg
    try {
      msg = JSON.parse(raw) as ServerMsg
    } catch {
      return
    }
    switch (msg.t) {
      case 'joined':
        this.myClientId = msg.youAre.clientId
        this.viewerSeat = msg.youAre.seat
        this.amSpectator = msg.youAre.spectator
        break
      case 'denied':
        this.deniedCb?.(msg.reason)
        break
      case 'error':
        this.errorCb?.(msg.message)
        break
      case 'room':
        this.hostClientId = msg.room.hostClientId
        this.presence = msg.room.members.map((m) => ({
          playerId: m.playerId,
          name: m.name,
          seat: m.seat,
          connected: m.connected,
          spectator: m.spectator,
        }))
        this.players = msg.room.members
          .filter((m) => m.seat !== null)
          .map((m) => ({ id: m.playerId, name: m.name, seat: m.seat! }))
        // keep our seat + spectator status in sync
        {
          const me = msg.room.members.find((m) => m.clientId === this.myClientId)
          if (me) {
            this.viewerSeat = me.seat
            this.amSpectator = me.spectator
          }
        }
        // Reactive room metadata for the UI (host, visibility, phase, counts).
        this.roomInfo = {
          isHost: this.myClientId !== null && this.myClientId === this.hostClientId,
          amSpectator: this.amSpectator,
          visibility: msg.room.spectatorVisibility ?? 'public',
          phase: msg.room.phase ?? 'lobby',
          seated: msg.room.members.filter((m) => m.seat !== null && m.connected)
            .length,
          here: msg.room.members.filter((m) => m.connected).length,
          minPlayers: msg.room.minPlayers ?? 2,
          maxPlayers: msg.room.maxPlayers ?? 6,
          rev: this.roomInfo.rev + 1,
        }
        // Notify the UI that room membership/host changed (presence, seating)
        // even though no game state arrived — so the lobby/room bar updates.
        for (const cb of this.presenceCbs) cb()
        if (this.view) for (const cb of this.changeCbs) cb(this.view)
        break
      case 'state':
        this.view = {
          ready: true,
          state: msg.state as S,
          legalMoves: msg.legalMoves as M[],
          scores: msg.scores,
          isMyTurn:
            this.viewerSeat !== null &&
            msg.state.activeSeat === this.viewerSeat,
        }
        for (const cb of this.changeCbs) cb(this.view)
        break
      case 'chat':
        this.chat = msg.messages
        for (const cb of this.chatCbs) cb(this.chat)
        break
    }
  }

  private sendRaw(obj: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj))
    }
  }

  // --- host/room intents (beyond the base interface) -----------------------
  takeSeat(seat: Seat) {
    this.sendRaw({ t: 'take-seat', roomId: this.opts.roomId, seat })
  }
  startGame() {
    this.sendRaw({ t: 'start', roomId: this.opts.roomId })
  }
  endGame() {
    this.sendRaw({ t: 'end', roomId: this.opts.roomId })
  }
  setVisibility(visibility: 'public' | 'locked', passcode?: string) {
    this.sendRaw({ t: 'set-visibility', roomId: this.opts.roomId, visibility, passcode })
  }

  // --- GameTransport --------------------------------------------------------
  getView(): TransportView<S, M> {
    return (
      this.view ?? {
        ready: false,
        state: {} as S,
        legalMoves: [],
        scores: null,
        isMyTurn: false,
      }
    )
  }

  async submitMove(move: M) {
    this.sendRaw({ t: 'move', roomId: this.opts.roomId, move })
    return { ok: true } // server validates; rejections arrive via 'error'
  }

  onChange(cb: (v: TransportView<S, M>) => void) {
    this.changeCbs.add(cb)
    if (this.view) cb(this.view)
    return () => this.changeCbs.delete(cb)
  }

  getPresence() {
    return this.presence
  }

  /** Subscribe to room/presence/host changes (online-only). */
  onPresence(cb: () => void) {
    this.presenceCbs.add(cb)
    return () => this.presenceCbs.delete(cb)
  }

  /** Reactive-friendly room metadata (host, visibility, phase, counts). */
  getRoomInfo(): RoomInfo {
    return this.roomInfo
  }

  async sendChat(body: string) {
    const trimmed = body.trim()
    if (!trimmed) return { ok: false, error: 'empty' }
    this.sendRaw({ t: 'chat', roomId: this.opts.roomId, body: trimmed })
    return { ok: true }
  }

  onChat(cb: (m: ChatMessage[]) => void) {
    this.chatCbs.add(cb)
    cb(this.chat)
    return () => this.chatCbs.delete(cb)
  }
  getChat() {
    return this.chat
  }
  getPlayers() {
    return this.players
  }

  destroy() {
    this.sendRaw({ t: 'leave', roomId: this.opts.roomId })
    this.ws?.close()
    this.changeCbs.clear()
    this.chatCbs.clear()
  }
}
