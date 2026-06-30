/**
 * RoomHub tests — server-authoritative online logic, exercised with a mock
 * crossws peer (no real socket). Covers: seating, start gate, hidden-hand
 * redaction, illegal/out-of-turn rejection, and spectator access control.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { RoomHub, type WsPeer } from '../server/utils/roomHub'
import type { RoomConfig } from '../server/utils/roomTypes'
import { defaultLastCardConfig } from '@card-games/game-last-card'

/** A mock peer that records everything sent to it. */
class MockPeer implements WsPeer {
  sent: Array<Record<string, unknown>> = []
  subscriptions = new Set<string>()
  constructor(public id: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  subscribe(t: string) {
    this.subscriptions.add(t)
  }
  unsubscribe(t: string) {
    this.subscriptions.delete(t)
  }
  publish() {
    /* not used by tests */
  }
  last(type: string) {
    return [...this.sent].reverse().find((m) => m.t === type)
  }
}

function lastCardConfig(over: Partial<RoomConfig> = {}): RoomConfig {
  return {
    gameId: 'last-card',
    gameConfig: defaultLastCardConfig(),
    maxPlayers: 4,
    minPlayers: 2,
    spectatorVisibility: 'public',
    spectatorPasscode: '',
    ...over,
  }
}

describe('RoomHub — reconnection', () => {
  let hub: RoomHub
  beforeEach(() => {
    hub = new RoomHub()
  })

  it('a player who reconnects (new clientId, same playerId) reclaims their seat', () => {
    const roomId = hub.createRoom(lastCardConfig())
    const a = new MockPeer('A')
    const b = new MockPeer('B')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))
    expect(a.last('joined').youAre.seat).toBe(0)

    // A's tab closes (disconnect, seat kept), then reopens with a NEW clientId.
    hub.onClose(a)
    const a2 = new MockPeer('A2') // new connection, same stable playerId 'pa'
    hub.onMessage(a2, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))

    // Reclaims seat 0 — NOT a fresh spectator (this was the screenshot bug).
    expect(a2.last('joined').youAre.seat).toBe(0)
    expect(a2.last('joined').youAre.spectator).toBe(false)
    // The room shows exactly 2 seated, both connected (no orphaned ghost member).
    const room = a2.last('room').room
    const seated = room.members.filter((m: { seat: number | null }) => m.seat !== null)
    expect(seated.length).toBe(2)
    expect(room.members.every((m: { connected: boolean }) => m.connected)).toBe(true)
    // A2 receives game state with its own hand visible.
    expect(a2.last('state').state.hands['0'].length).toBeGreaterThan(0)
  })

  it('sets a reconnect grace deadline when a seated player drops mid-game', () => {
    const roomId = hub.createRoom(lastCardConfig())
    const a = new MockPeer('A')
    const b = new MockPeer('B')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))

    hub.onClose(b)
    const room = a.last('room').room
    expect(room.disconnectGraceUntil).toBeTruthy()
    expect(room.phase).toBe('in-progress') // not ended yet — grace window open

    // Reconnect clears the countdown.
    const b2 = new MockPeer('B2')
    hub.onMessage(b2, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    expect(a.last('room').room.disconnectGraceUntil).toBeNull()
  })
})

describe('RoomHub — seating & start', () => {
  let hub: RoomHub
  beforeEach(() => {
    hub = new RoomHub()
  })

  it('seats joiners, gates start on min players, then deals', () => {
    const roomId = hub.createRoom(lastCardConfig())
    const a = new MockPeer('A')
    const b = new MockPeer('B')

    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    // A is host, seated at 0.
    expect(a.last('joined').isHost).toBe(true)
    expect(a.last('joined').youAre.seat).toBe(0)

    // Start with only 1 player → rejected.
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))
    expect(a.last('error')?.message).toMatch(/at least/i)

    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))

    // Both now receive state.
    expect(a.last('state')).toBeTruthy()
    expect(b.last('state')).toBeTruthy()
  })

  it('redacts hidden hands per viewer', () => {
    const roomId = hub.createRoom(lastCardConfig())
    const a = new MockPeer('A')
    const b = new MockPeer('B')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))

    const aState = a.last('state').state
    const bState = b.last('state').state
    // A sees its own real hand (seat 0). B's hand count is preserved (for backs
    // + animations) but the identities are hidden (face-down placeholders), and
    // A's view of B must NOT match B's view of B.
    expect(aState.hands['0'].length).toBe(7)
    expect(aState.hands['1'].length).toBe(7)
    expect(aState.hands['1']).not.toEqual(bState.hands['1'])
    // B sees the mirror.
    expect(bState.hands['1'].length).toBe(7)
    expect(bState.hands['0'].length).toBe(7)
    expect(bState.hands['0']).not.toEqual(aState.hands['0'])
  })

  it('rejects an out-of-turn / illegal move', () => {
    const roomId = hub.createRoom(lastCardConfig())
    const a = new MockPeer('A')
    const b = new MockPeer('B')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))

    // B (seat 1) tries to move when it's seat 0's turn.
    hub.onMessage(
      b,
      JSON.stringify({ t: 'move', roomId, move: { type: 'draw', seat: 1 } }),
    )
    expect(b.last('error')).toBeTruthy()
  })
})

describe('RoomHub — spectator access control', () => {
  let hub: RoomHub
  beforeEach(() => {
    hub = new RoomHub()
  })

  it('public room admits a spectator', () => {
    const roomId = hub.createRoom(lastCardConfig({ spectatorVisibility: 'public' }))
    const s = new MockPeer('S')
    hub.onMessage(
      s,
      JSON.stringify({ t: 'join', roomId, playerId: 'ps', name: 'S', asSpectator: true }),
    )
    expect(s.last('joined')?.youAre.spectator).toBe(true)
    expect(s.last('denied')).toBeUndefined()
  })

  it('locked room rejects a spectator without the passcode and sends no state', () => {
    const roomId = hub.createRoom(
      lastCardConfig({ spectatorVisibility: 'locked', spectatorPasscode: '1234' }),
    )
    // seat a player and start so there IS state to (not) leak
    const a = new MockPeer('A')
    const b = new MockPeer('B')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(b, JSON.stringify({ t: 'join', roomId, playerId: 'pb', name: 'B' }))
    hub.onMessage(a, JSON.stringify({ t: 'start', roomId }))

    const s = new MockPeer('S')
    hub.onMessage(
      s,
      JSON.stringify({ t: 'join', roomId, playerId: 'ps', name: 'S', asSpectator: true, spectatorPasscode: 'wrong' }),
    )
    expect(s.last('denied')).toBeTruthy()
    expect(s.last('state')).toBeUndefined() // no game state leaked
  })

  it('locked room admits a spectator with the correct passcode', () => {
    const roomId = hub.createRoom(
      lastCardConfig({ spectatorVisibility: 'locked', spectatorPasscode: '1234' }),
    )
    const s = new MockPeer('S')
    hub.onMessage(
      s,
      JSON.stringify({ t: 'join', roomId, playerId: 'ps', name: 'S', asSpectator: true, spectatorPasscode: '1234' }),
    )
    expect(s.last('joined')?.youAre.spectator).toBe(true)
  })

  it('host can lock a previously-public room', () => {
    const roomId = hub.createRoom(lastCardConfig({ spectatorVisibility: 'public' }))
    const a = new MockPeer('A')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    hub.onMessage(
      a,
      JSON.stringify({ t: 'set-visibility', roomId, visibility: 'locked', passcode: '9999' }),
    )
    const s = new MockPeer('S')
    hub.onMessage(
      s,
      JSON.stringify({ t: 'join', roomId, playerId: 'ps', name: 'S', asSpectator: true }),
    )
    expect(s.last('denied')).toBeTruthy()
  })
})

describe('RoomHub — custom ids & public listing', () => {
  let hub: RoomHub
  beforeEach(() => {
    hub = new RoomHub()
  })

  it('honors a sanitized custom id and falls back when it collides', () => {
    const id = hub.createRoom(lastCardConfig(), 'Friday Night!')
    expect(id).toBe('friday-night')
    // Same requested id again → must not collide, so a generated id is used.
    const id2 = hub.createRoom(lastCardConfig(), 'friday-night')
    expect(id2).not.toBe('friday-night')
  })

  it('deletes a room immediately when the last member explicitly leaves', () => {
    const roomId = hub.createRoom(lastCardConfig(), 'leavers')
    const a = new MockPeer('A')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId, playerId: 'pa', name: 'A' }))
    expect(hub.getRoom(roomId)).toBeTruthy()
    hub.onMessage(a, JSON.stringify({ t: 'leave', roomId }))
    expect(hub.getRoom(roomId)).toBeUndefined()
  })

  it('lists public, non-finished rooms but hides locked ones', () => {
    const pub = hub.createRoom(lastCardConfig({ spectatorVisibility: 'public' }), 'open-table')
    hub.createRoom(
      lastCardConfig({ spectatorVisibility: 'locked', spectatorPasscode: '1234' }),
      'secret',
    )
    const a = new MockPeer('A')
    hub.onMessage(a, JSON.stringify({ t: 'join', roomId: pub, playerId: 'pa', name: 'A' }))

    const list = hub.listPublicRooms()
    expect(list.map((r) => r.id)).toEqual(['open-table'])
    expect(list[0]!.seated).toBe(1)
    expect(list[0]!.maxPlayers).toBe(4)
  })
})
