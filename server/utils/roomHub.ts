/**
 * RoomHub — server-authoritative room & game manager (crossws-driven).
 *
 * Holds canonical engine state per room, validates moves through the engine
 * reducer before broadcasting, redacts state per recipient (no hidden-hand
 * leaks), and enforces host controls + spectator access control (public vs
 * locked + passcode).
 *
 * Broadcast uses crossws topic pub/sub: every member subscribes to
 * `room:<id>`. Because *state* must be redacted per viewer, state is sent with
 * direct `peer.send` per peer; room snapshots and chat (public) use publish.
 */
import {
  type BaseGameState,
  type BaseMove,
  type Player,
  type Seat,
  applyMove,
  requireGame,
} from '@card-games/engine-core'
import { registerLastCard } from '@card-games/game-last-card'
import { registerAlbastini } from '@card-games/game-albastini'
import type {
  ChatMessage,
  ClientMessage,
  PublicRoomInfo,
  RoomConfig,
  RoomMember,
  RoomPhase,
  RoomSnapshot,
  ServerMessage,
} from './roomTypes'

/** Minimal crossws peer surface we rely on. */
export interface WsPeer {
  id: string
  send(data: string): void
  subscribe(topic: string): void
  unsubscribe(topic: string): void
  publish(topic: string, data: string): void
}

let registered = false
function ensureGames() {
  if (registered) return
  registerLastCard()
  registerAlbastini()
  registered = true
}

interface Room {
  config: RoomConfig
  phase: RoomPhase
  hostClientId: string | null
  members: Map<string, RoomMember> // by clientId (peer id)
  peers: Map<string, WsPeer> // clientId → peer
  state: BaseGameState | null
  chat: ChatMessage[]
  startedAt: string | null
  endedAt: string | null
  /** Epoch ms by which a dropped seated player must reconnect, else auto-end. */
  disconnectGraceUntil: number | null
  /** Name of the host who manually ended the game (End button); null otherwise. */
  endedBy: string | null
}

let counter = 0
function genId(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter}`
}

const topicFor = (roomId: string) => `room:${roomId}`

/** How long an empty room lingers before it's reaped (ms) — covers reconnects. */
const EMPTY_ROOM_GRACE_MS = 60_000
/** How long a disconnected SEATED player has to reconnect before the in-progress
 *  game is auto-ended (ms). The client shows a countdown of the same length. */
const PLAYER_GRACE_MS = 30_000

export class RoomHub {
  private rooms = new Map<string, Room>()
  /** Which room a peer is currently in (peer.id → roomId). */
  private peerRoom = new Map<string, string>()
  /** Pending deletion timers for rooms that just went empty. */
  private reapTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Per-disconnected-player grace timers (clientId → timer). */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor() {
    ensureGames()
  }

  /** Cancel a player's reconnect-grace timer (they came back, or were removed). */
  private cancelGrace(clientId: string) {
    const t = this.graceTimers.get(clientId)
    if (t) {
      clearTimeout(t)
      this.graceTimers.delete(clientId)
    }
  }

  /** True when no member of the room is still connected. */
  private isEmpty(room: Room): boolean {
    for (const m of room.members.values()) if (m.connected) return false
    return true
  }

  /**
   * Schedule deletion of a room once it has no connected members. The grace
   * period lets a sole player reconnect (refresh, flaky network) without losing
   * the room. Any later join cancels the timer (see onJoin).
   */
  private scheduleReap(roomId: string) {
    const room = this.rooms.get(roomId)
    if (!room) return
    if (!this.isEmpty(room)) return this.cancelReap(roomId)
    if (this.reapTimers.has(roomId)) return
    const timer = setTimeout(() => {
      this.reapTimers.delete(roomId)
      const r = this.rooms.get(roomId)
      if (r && this.isEmpty(r)) this.rooms.delete(roomId)
    }, EMPTY_ROOM_GRACE_MS)
    // Don't keep the process alive just for a reap timer.
    ;(timer as { unref?: () => void }).unref?.()
    this.reapTimers.set(roomId, timer)
  }

  private cancelReap(roomId: string) {
    const t = this.reapTimers.get(roomId)
    if (t) {
      clearTimeout(t)
      this.reapTimers.delete(roomId)
    }
  }

  /**
   * Create a room. An optional `customId` lets the host pick a memorable id;
   * it's sanitized and must be unused, otherwise we fall back to a generated id.
   */
  createRoom(config: RoomConfig, customId?: string): string {
    const id = this.resolveId(customId)
    this.rooms.set(id, {
      config,
      phase: 'lobby',
      hostClientId: null,
      members: new Map(),
      peers: new Map(),
      state: null,
      chat: [],
      startedAt: null,
      endedAt: null,
      disconnectGraceUntil: null,
      endedBy: null,
    })
    return id
  }

  /** Sanitize a requested custom id; fall back to a generated id if taken/empty. */
  private resolveId(customId?: string): string {
    const clean = (customId ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32)
    if (clean && !this.rooms.has(clean)) return clean
    return genId('room')
  }

  getRoom(id: string) {
    return this.rooms.get(id)
  }

  /**
   * Public, joinable rooms for the spectate lobby. Excludes locked rooms (their
   * existence/passcode shouldn't leak) and finished rooms. No secrets included.
   */
  listPublicRooms(): PublicRoomInfo[] {
    const out: PublicRoomInfo[] = []
    for (const [id, room] of this.rooms) {
      if (room.config.spectatorVisibility !== 'public') continue
      if (room.phase === 'finished') continue
      const members = [...room.members.values()]
      out.push({
        id,
        gameId: room.config.gameId,
        phase: room.phase,
        seated: members.filter((m) => m.seat !== null).length,
        spectators: members.filter((m) => m.spectator && m.connected).length,
        maxPlayers: room.config.maxPlayers,
        startedAt: room.startedAt,
      })
    }
    return out
  }

  // --- crossws lifecycle ----------------------------------------------------

  onMessage(peer: WsPeer, raw: string) {
    let msg: ClientMessage
    try {
      msg = JSON.parse(raw) as ClientMessage
    } catch {
      return this.send(peer, { t: 'error', message: 'bad message' })
    }
    switch (msg.t) {
      case 'join':
        return this.onJoin(peer, msg)
      case 'take-seat':
        return this.onTakeSeat(peer, msg)
      case 'start':
        return this.onStart(peer, msg)
      case 'end':
        return this.onEnd(peer, msg)
      case 'move':
        return this.onMove(peer, msg)
      case 'chat':
        return this.onChat(peer, msg)
      case 'set-visibility':
        return this.onSetVisibility(peer, msg)
      case 'leave':
        return this.onLeave(peer)
    }
  }

  onClose(peer: WsPeer) {
    const roomId = this.peerRoom.get(peer.id)
    if (!roomId) return
    const room = this.rooms.get(roomId)
    const member = room?.members.get(peer.id)
    if (room && member) {
      member.connected = false // keep seat for grace-period reconnect
      if (room.hostClientId === peer.id) {
        const next = [...room.members.values()].find(
          (m) => m.seat !== null && m.connected,
        )
        room.hostClientId = next?.clientId ?? room.hostClientId
      }
      room.peers.delete(peer.id)

      // A SEATED player dropping out of an IN-PROGRESS game starts a reconnect
      // countdown. If they don't return in time, the game is auto-ended. The
      // deadline is broadcast so clients can show a live countdown.
      if (member.seat !== null && room.phase === 'in-progress') {
        room.disconnectGraceUntil = Date.now() + PLAYER_GRACE_MS
        const droppedClientId = peer.id
        const timer = setTimeout(() => {
          this.graceTimers.delete(droppedClientId)
          const r = this.rooms.get(roomId)
          if (!r) return
          const m = r.members.get(droppedClientId)
          // Only end if still gone and the game is still running.
          if (m && !m.connected && r.phase === 'in-progress') {
            r.phase = 'finished'
            r.endedAt = new Date().toISOString()
            r.disconnectGraceUntil = null
            this.broadcastRoom(r)
          }
        }, PLAYER_GRACE_MS)
        ;(timer as { unref?: () => void }).unref?.()
        this.graceTimers.set(peer.id, timer)
      }

      this.broadcastRoom(room)
      this.scheduleReap(roomId)
    }
    this.peerRoom.delete(peer.id)
  }

  // --- Spectator access control --------------------------------------------

  private onJoin(peer: WsPeer, msg: Extract<ClientMessage, { t: 'join' }>) {
    const room = this.rooms.get(msg.roomId)
    if (!room) return this.send(peer, { t: 'denied', reason: 'no such room' })
    // Someone's joining → cancel any pending empty-room deletion.
    this.cancelReap(msg.roomId)

    // Locked rooms require the passcode for ANY entry — players and spectators.
    const codeOk =
      room.config.spectatorVisibility === 'public' ||
      (!!msg.spectatorPasscode &&
        msg.spectatorPasscode === room.config.spectatorPasscode)
    if (room.config.spectatorVisibility === 'locked' && !codeOk) {
      return this.send(peer, {
        t: 'denied',
        reason: 'this room is private — a passcode is required to join',
      })
    }

    // RECONNECTION: an existing member with the same stable playerId (e.g. the
    // player refreshed or their tab was closed) reclaims its seat/host status
    // under the NEW connection. The stale entry is removed so counts stay right.
    const prior = [...room.members.values()].find(
      (m) => m.playerId === msg.playerId,
    )
    let member: RoomMember
    if (prior) {
      const wasHost = room.hostClientId === prior.clientId
      room.members.delete(prior.clientId)
      room.peers.delete(prior.clientId)
      this.cancelGrace(prior.clientId)
      member = {
        clientId: peer.id,
        playerId: prior.playerId,
        name: msg.name || prior.name,
        seat: prior.seat, // reclaim the original seat (may be null for spectators)
        spectator: prior.spectator,
        connected: true,
      }
      if (wasHost) room.hostClientId = peer.id
      // If every seated player is connected again, clear the auto-end countdown.
      room.members.set(peer.id, member) // provisional, so the check below sees us
      const anyoneStillGone = [...room.members.values()].some(
        (m) => m.seat !== null && !m.connected && m.clientId !== peer.id,
      )
      if (!anyoneStillGone) room.disconnectGraceUntil = null
    } else {
      const seatedCount = [...room.members.values()].filter(
        (m) => m.seat !== null,
      ).length
      const wantsSeat =
        !msg.asSpectator &&
        room.phase === 'lobby' &&
        seatedCount < room.config.maxPlayers
      member = {
        clientId: peer.id,
        playerId: msg.playerId,
        name: msg.name,
        seat: wantsSeat ? seatedCount : null,
        spectator: !wantsSeat,
        connected: true,
      }
    }

    room.members.set(peer.id, member)
    room.peers.set(peer.id, peer)
    this.peerRoom.set(peer.id, msg.roomId)
    peer.subscribe(topicFor(msg.roomId))
    if (!room.hostClientId && !member.spectator) room.hostClientId = peer.id

    this.send(peer, {
      t: 'joined',
      roomId: msg.roomId,
      youAre: {
        clientId: peer.id,
        seat: member.seat,
        spectator: member.spectator,
      },
      isHost: room.hostClientId === peer.id,
    })
    this.broadcastRoom(room)
    this.send(peer, { t: 'chat', messages: room.chat })
    if (room.state) this.sendStateTo(room, peer)
  }

  private onTakeSeat(
    peer: WsPeer,
    msg: Extract<ClientMessage, { t: 'take-seat' }>,
  ) {
    const room = this.rooms.get(msg.roomId)
    if (!room || room.phase !== 'lobby') return
    const member = room.members.get(peer.id)
    if (!member) return
    const taken = new Set(
      [...room.members.values()].map((m) => m.seat).filter((s) => s !== null),
    )
    if (taken.has(msg.seat) || msg.seat >= room.config.maxPlayers) return
    member.seat = msg.seat
    member.spectator = false
    if (!room.hostClientId) room.hostClientId = peer.id
    this.broadcastRoom(room)
  }

  private onStart(peer: WsPeer, msg: Extract<ClientMessage, { t: 'start' }>) {
    const room = this.rooms.get(msg.roomId)
    // Host may start from the lobby OR restart a finished game (rematch); an
    // in-progress game can't be restarted out from under the players.
    if (!room || room.hostClientId !== peer.id || room.phase === 'in-progress') {
      return
    }
    const seated = [...room.members.values()]
      .filter((m) => m.seat !== null)
      .sort((a, b) => a.seat! - b.seat!)
    if (seated.length < room.config.minPlayers) {
      return this.send(peer, {
        t: 'error',
        message: `Need at least ${room.config.minPlayers} players`,
      })
    }
    const game = requireGame(room.config.gameId)
    const players: Player[] = seated.map((m) => ({
      id: m.playerId,
      name: m.name,
      seat: m.seat!,
    }))
    room.state = game.createInitialState(
      room.config.gameConfig,
      players,
      genId('seed'),
    )
    room.phase = 'in-progress'
    room.startedAt = new Date().toISOString()
    // Fresh game → clear any prior end/grace markers.
    room.endedAt = null
    room.endedBy = null
    room.disconnectGraceUntil = null
    this.broadcastRoom(room)
    this.broadcastState(room)
  }

  private onEnd(peer: WsPeer, msg: Extract<ClientMessage, { t: 'end' }>) {
    const room = this.rooms.get(msg.roomId)
    if (!room || room.hostClientId !== peer.id) return
    room.phase = 'finished'
    room.endedAt = new Date().toISOString()
    // Record who ended it so every client can notify (natural/auto ends leave
    // this null).
    room.endedBy = room.members.get(peer.id)?.name ?? 'The host'
    this.broadcastRoom(room)
  }

  private onMove(peer: WsPeer, msg: Extract<ClientMessage, { t: 'move' }>) {
    const room = this.rooms.get(msg.roomId)
    if (!room || !room.state || room.phase !== 'in-progress') return
    const member = room.members.get(peer.id)
    if (!member || member.seat === null) return // spectators can't move

    const move = msg.move as BaseMove
    if (move.seat !== member.seat) {
      return this.send(peer, { t: 'error', message: 'not your seat' })
    }
    const game = requireGame(room.config.gameId)
    const result = applyMove(game, room.state, move)
    if (!result.ok) {
      return this.send(peer, { t: 'error', message: result.error })
    }
    room.state = result.state
    if (game.isTerminal(room.state)) {
      room.phase = 'finished'
      room.endedAt = new Date().toISOString()
      this.broadcastRoom(room)
    }
    this.broadcastState(room)
  }

  private onChat(peer: WsPeer, msg: Extract<ClientMessage, { t: 'chat' }>) {
    const room = this.rooms.get(msg.roomId)
    if (!room) return
    const member = room.members.get(peer.id)
    if (!member) return
    const body = msg.body.trim()
    if (!body || body.length > 500) return
    room.chat.push({
      id: genId('msg'),
      senderId: member.playerId,
      senderName: member.name,
      body,
      at: new Date().toISOString(),
    })
    if (room.chat.length > 200) room.chat = room.chat.slice(-200)
    // Chat is public to the room → publish to the topic.
    this.publishRoom(room, { t: 'chat', messages: room.chat })
  }

  private onSetVisibility(
    peer: WsPeer,
    msg: Extract<ClientMessage, { t: 'set-visibility' }>,
  ) {
    const room = this.rooms.get(msg.roomId)
    if (!room || room.hostClientId !== peer.id) return
    room.config.spectatorVisibility = msg.visibility
    if (msg.visibility === 'locked' && msg.passcode !== undefined) {
      room.config.spectatorPasscode = msg.passcode
    }
    this.broadcastRoom(room)
  }

  private onLeave(peer: WsPeer) {
    const roomId = this.peerRoom.get(peer.id)
    if (!roomId) return
    const room = this.rooms.get(roomId)
    if (!room) return
    this.cancelGrace(peer.id) // explicit leave → no reconnect grace
    room.members.delete(peer.id)
    room.peers.delete(peer.id)
    peer.unsubscribe(topicFor(roomId))
    if (room.hostClientId === peer.id) {
      const next = [...room.members.values()].find((m) => m.seat !== null)
      room.hostClientId = next?.clientId ?? null
    }
    this.peerRoom.delete(peer.id)
    // An explicit leave that empties the room → delete it right away.
    if (room.members.size === 0) {
      this.cancelReap(roomId)
      this.rooms.delete(roomId)
      return
    }
    this.broadcastRoom(room)
    this.scheduleReap(roomId)
  }

  // --- Broadcast helpers ----------------------------------------------------

  private roomId(room: Room): string {
    return [...this.rooms.entries()].find(([, r]) => r === room)?.[0] ?? ''
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      id: this.roomId(room),
      gameId: room.config.gameId,
      phase: room.phase,
      hostClientId: room.hostClientId,
      members: [...room.members.values()],
      maxPlayers: room.config.maxPlayers,
      minPlayers: room.config.minPlayers,
      spectatorVisibility: room.config.spectatorVisibility,
      startedAt: room.startedAt,
      endedAt: room.endedAt,
      disconnectGraceUntil: room.disconnectGraceUntil,
      endedBy: room.endedBy,
    }
  }

  private broadcastRoom(room: Room) {
    this.publishRoom(room, { t: 'room', room: this.snapshot(room) })
  }

  /** Publish a public message to every member of the room. */
  private publishRoom(room: Room, msg: ServerMessage) {
    const data = JSON.stringify(msg)
    const topic = topicFor(this.roomId(room))
    // Publish reaches OTHER subscribers; also send to each peer directly so the
    // sender/host sees it too (crossws publish excludes the publisher).
    for (const peer of room.peers.values()) {
      peer.send(data)
    }
    void topic
  }

  private sendStateTo(room: Room, peer: WsPeer) {
    if (!room.state) return
    const game = requireGame(room.config.gameId)
    const member = room.members.get(peer.id)
    const viewer: Seat | null = member?.seat ?? null
    const redacted = game.redactFor(room.state, viewer)
    // Always ask the engine — it returns the on-turn moves for the active seat
    // AND any off-turn moves (e.g. an out-of-turn "Last Card" declaration for a
    // seat that reduced to one card). The engine returns [] when there's nothing.
    const legalMoves =
      viewer !== null ? game.getLegalMoves(room.state, viewer) : []
    const scores = game.isTerminal(room.state)
      ? game.getScores(room.state)
      : null
    this.send(peer, { t: 'state', state: redacted, legalMoves, scores })
  }

  private broadcastState(room: Room) {
    // State is redacted per viewer → must send individually.
    for (const peer of room.peers.values()) this.sendStateTo(room, peer)
  }

  private send(peer: WsPeer, msg: ServerMessage) {
    try {
      peer.send(JSON.stringify(msg))
    } catch {
      /* peer gone */
    }
  }

  dispose() {
    for (const t of this.reapTimers.values()) clearTimeout(t)
    for (const t of this.graceTimers.values()) clearTimeout(t)
    this.reapTimers.clear()
    this.graceTimers.clear()
    this.rooms.clear()
    this.peerRoom.clear()
  }
}

let hub: RoomHub | null = null
export function getRoomHub(): RoomHub {
  if (!hub) hub = new RoomHub()
  return hub
}
