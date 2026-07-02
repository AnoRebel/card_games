import { describe, it, expect } from 'vitest'
import {
  applyMove,
  replay,
  type Card,
  type Player,
  type Seat,
} from '@card-games/engine-core'
import {
  lastCardGame,
  defaultLastCardConfig,
  canPlay,
  type LastCardMove,
  type LastCardState,
} from '../src/index'

const players: Player[] = [
  { id: 'a', name: 'A', seat: 0 },
  { id: 'b', name: 'B', seat: 1 },
  { id: 'c', name: 'C', seat: 2 },
]

const init = (seed = 'lc', cfg = defaultLastCardConfig()) =>
  lastCardGame.createInitialState(cfg, players, seed)

const handCount = (s: LastCardState, seat: Seat) => s.hands[seat]!.length

describe('Last Card — deal & start', () => {
  it('deals the configured hand size to each player and turns one start card', () => {
    const s = init()
    expect(handCount(s, 0)).toBe(7)
    expect(handCount(s, 1)).toBe(7)
    expect(handCount(s, 2)).toBe(7)
    expect(s.discardPile).toHaveLength(1)
    // 52 - 21 dealt - 1 start = 30 in draw pile
    expect(s.drawPile).toHaveLength(30)
    expect(s.activeSeat).toBe(0)
  })

  it('start card is not an action card when redrawActionStart is on', () => {
    const cfg = defaultLastCardConfig()
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      const s = init(seed, cfg)
      const top = s.discardPile[0]!
      const isAction =
        cfg.pickupCards.some((p) => p.rank === top.rank) ||
        cfg.skipCards.includes(top.rank) ||
        cfg.suitChangeCards.includes(top.rank)
      expect(isAction).toBe(false)
    }
  })
})

describe('Last Card — matching', () => {
  it('allows suit match and rank match', () => {
    const s = init()
    // Force a known top card.
    const test: LastCardState = { ...s, discardPile: [{ rank: 7, suit: 'h' }], activeSuit: 'h' }
    expect(canPlay(test, { rank: 7, suit: 'c' })).toBe(true) // rank match
    expect(canPlay(test, { rank: 4, suit: 'h' })).toBe(true) // suit match
    expect(canPlay(test, { rank: 4, suit: 'c' })).toBe(false)
  })

  it('Jack (suit-change) is always playable', () => {
    const s = init()
    const test: LastCardState = { ...s, discardPile: [{ rank: 7, suit: 'h' }], activeSuit: 'h' }
    expect(canPlay(test, { rank: 11, suit: 'c' })).toBe(true)
  })
})

describe('Last Card — action cards', () => {
  it('a 2 sets a pending pickup; drawing takes the penalty and ends turn', () => {
    let s = init()
    // Construct a controlled state: seat 0 to play a 2 of the active suit.
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 2, suit: 'h' }, { rank: 9, suit: 's' }], 1: [{ rank: 9, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 2, suit: 'h' } } as LastCardMove)
    expect(r1.ok).toBe(true)
    const after = (r1 as { state: LastCardState }).state
    expect(after.pendingPickup).toBe(2)
    expect(after.activeSeat).toBe(1)

    // Seat 1 has no pickup card → must draw the penalty.
    const before1 = handCount(after, 1)
    const r2 = applyMove(lastCardGame, after, { type: 'draw', seat: 1 } as LastCardMove)
    expect(r2.ok).toBe(true)
    const after2 = (r2 as { state: LastCardState }).state
    expect(handCount(after2, 1)).toBe(before1 + 2)
    expect(after2.pendingPickup).toBe(0)
    expect(after2.activeSeat).toBe(2)
  })

  it('pickup stacking accumulates and passes on', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 2, suit: 'h' }, { rank: 9, suit: 's' }], 1: [{ rank: 2, suit: 'c' }, { rank: 9, suit: 'h' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 2, suit: 'h' } } as LastCardMove)
    s = (r1 as { state: LastCardState }).state
    // Seat 1 stacks a 2.
    const r2 = applyMove(lastCardGame, s, { type: 'play', seat: 1, card: { rank: 2, suit: 'c' } } as LastCardMove)
    expect(r2.ok).toBe(true)
    s = (r2 as { state: LastCardState }).state
    expect(s.pendingPickup).toBe(4)
    expect(s.activeSeat).toBe(2)
  })

  it('Jack changes the suit to the nominated one', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 11, suit: 'h' }, { rank: 9, suit: 'c' }], 1: [{ rank: 9, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    const r = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 11, suit: 'h' }, chosenSuit: 'd' } as LastCardMove)
    expect(r.ok).toBe(true)
    expect((r as { state: LastCardState }).state.activeSuit).toBe('d')
  })

  it('an 8 skips the next player', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 8, suit: 'h' }, { rank: 9, suit: 'c' }], 1: [{ rank: 9, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    const r = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 8, suit: 'h' } } as LastCardMove)
    expect(r.ok).toBe(true)
    expect((r as { state: LastCardState }).state.activeSeat).toBe(2) // 1 is skipped
  })
})

describe('Last Card — last card call & penalty', () => {
  it('a remaining same-rank PAIR counts as "last card(s)" and can be declared', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      // After playing 4h, seat 0 is left with a PAIR of 9s (one group → last cards).
      hands: {
        0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 9, suit: 's' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'd' }],
      },
    }
    // Play 4h plain (no declare) → left with the 9-pair → awaitingCall set.
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' } } as LastCardMove)
    s = (r1 as { state: LastCardState }).state
    expect(handCount(s, 0)).toBe(2)
    expect(s.awaitingCall).toBe(0)

    // Seat 0 may declare OUT OF TURN with a pair remaining.
    expect(lastCardGame.getLegalMoves(s, 0)).toEqual([{ type: 'declare-last-card', seat: 0 }])
    const r2 = applyMove(lastCardGame, s, { type: 'declare-last-card', seat: 0 } as LastCardMove)
    expect(r2.ok).toBe(true)
    s = (r2 as { state: LastCardState }).state
    expect(s.declaredLastCard).toBe(0)
    expect(s.awaitingCall).toBeNull()
  })

  it('offers declare-with-play when a play leaves a same-rank pair', () => {
    const s = init()
    const test: LastCardState = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 9, suit: 's' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'd' }],
      },
    }
    const moves = lastCardGame.getLegalMoves(test, 0)
    // Playing 4h leaves the 9-pair → a declare variant of that play is offered.
    const declareVariant = moves.find(
      (m) =>
        m.type === 'play' &&
        m.card.rank === 4 &&
        m.card.suit === 'h' &&
        m.declareLastCard,
    )
    expect(declareVariant).toBeTruthy()
  })

  it('a two-card hand of DIFFERENT ranks is NOT a last-card state', () => {
    const s = init()
    const test: LastCardState = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 2, suit: 's' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'd' }],
      },
    }
    // Playing 4h leaves 9c + 2s (mixed ranks) → NOT last cards, no declare offered.
    const r = applyMove(lastCardGame, test, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' } } as LastCardMove)
    const after = (r as { state: LastCardState }).state
    expect(after.awaitingCall).toBeNull()
  })

  it('missing the declaration applies the penalty when the next player acts', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'h' }], 1: [{ rank: 9, suit: 'c' }, { rank: 3, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    // Seat 0 plays down to one card WITHOUT declaring.
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' } } as LastCardMove)
    s = (r1 as { state: LastCardState }).state
    expect(s.awaitingCall).toBe(0)
    const before = handCount(s, 0)
    // Seat 1 acts → window closes → seat 0 gets penalty.
    const r2 = applyMove(lastCardGame, s, { type: 'draw', seat: 1 } as LastCardMove)
    s = (r2 as { state: LastCardState }).state
    expect(handCount(s, 0)).toBe(before + 2)
    expect(s.awaitingCall).toBeNull()
  })

  it('allows an OUT-OF-TURN declaration before the next player acts', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'h' }], 1: [{ rank: 9, suit: 'c' }, { rank: 3, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    // Seat 0 plays plain → reaches one card, awaitingCall, turn passes to seat 1.
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' } } as LastCardMove)
    s = (r1 as { state: LastCardState }).state
    expect(s.awaitingCall).toBe(0)
    expect(s.activeSeat).toBe(1)

    // Seat 0 (NOT active) is offered a standalone declare move…
    const off = lastCardGame.getLegalMoves(s, 0)
    expect(off).toEqual([{ type: 'declare-last-card', seat: 0 }])
    // …and can play it out of turn.
    const before = handCount(s, 0)
    const r2 = applyMove(lastCardGame, s, { type: 'declare-last-card', seat: 0 } as LastCardMove)
    expect(r2.ok).toBe(true)
    s = (r2 as { state: LastCardState }).state
    expect(s.declaredLastCard).toBe(0)
    expect(s.awaitingCall).toBeNull()

    // Now when seat 1 acts, no penalty (they declared in time).
    const r3 = applyMove(lastCardGame, s, { type: 'draw', seat: 1 } as LastCardMove)
    s = (r3 as { state: LastCardState }).state
    expect(handCount(s, 0)).toBe(before)
  })

  it('a non-awaiting seat still gets "Not your turn" off-turn', () => {
    const s = init()
    // Seat 1 (not active, not awaiting) has no off-turn move.
    expect(lastCardGame.getLegalMoves(s, 1)).toEqual([])
    const r = applyMove(lastCardGame, s, { type: 'draw', seat: 1 } as LastCardMove)
    expect(r.ok).toBe(false)
  })

  it('declaring with the play avoids the penalty', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: { 0: [{ rank: 4, suit: 'h' }, { rank: 9, suit: 'h' }], 1: [{ rank: 9, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    const r1 = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' }, declareLastCard: true } as LastCardMove)
    s = (r1 as { state: LastCardState }).state
    expect(s.declaredLastCard).toBe(0)
    expect(s.awaitingCall).toBeNull()
    const before = handCount(s, 0)
    applyMove(lastCardGame, s, { type: 'draw', seat: 1 } as LastCardMove)
    expect(handCount(s, 0)).toBe(before) // no penalty
  })
})

describe('Last Card — multi same-rank plays', () => {
  it('offers a "play all of this rank" legal move when duplicates are held', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 9, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 4, suit: 'd' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'd' }],
      },
    }
    const moves = lastCardGame.getLegalMoves(s, 0)
    const multi = moves.find(
      (m) => m.type === 'play' && (m.extraCards?.length ?? 0) === 1,
    )
    expect(multi).toBeTruthy()
  })

  it('plays a pair: both cards leave the hand, effects apply per card', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 2, suit: 'h' }, { rank: 2, suit: 'c' }, { rank: 4, suit: 'd' }],
        1: [{ rank: 9, suit: 'c' }],
        2: [{ rank: 9, suit: 'd' }],
      },
    }
    const r = applyMove(lastCardGame, s, {
      type: 'play',
      seat: 0,
      card: { rank: 2, suit: 'h' },
      extraCards: [{ rank: 2, suit: 'c' }],
    } as LastCardMove)
    expect(r.ok).toBe(true)
    const after = (r as { state: LastCardState }).state
    expect(handCount(after, 0)).toBe(1) // pair removed from 3-card hand
    expect(after.pendingPickup).toBe(4) // two 2s = pickup 2 + 2
    expect(after.discardPile.slice(-2)).toEqual([
      { rank: 2, suit: 'h' },
      { rank: 2, suit: 'c' },
    ])
  })

  it('rejects a multi-play with a mismatched rank', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 9, suit: 'h' }, { rank: 4, suit: 'c' }],
        1: [{ rank: 9, suit: 'c' }],
        2: [{ rank: 9, suit: 'd' }],
      },
    }
    const r = applyMove(lastCardGame, s, {
      type: 'play',
      seat: 0,
      card: { rank: 9, suit: 'h' },
      extraCards: [{ rank: 4, suit: 'c' }],
    } as LastCardMove)
    expect(r.ok).toBe(false)
  })

  it('offers a top-card choice per distinct suit for a 3+ card bundle', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 9, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 9, suit: 's' }, { rank: 4, suit: 'd' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'd' }],
      },
    }
    const bundles = lastCardGame
      .getLegalMoves(s, 0)
      .filter((m) => m.type === 'play' && (m.extraCards?.length ?? 0) === 2)
    // The three 9s are h/c/s but only 9♥ is a LEGAL lead (active suit h). You
    // can leave ♣ or ♠ on top (9♥ leads), but NOT ♥ — the only legal lead can't
    // also be the last card. So exactly two choosable top suits (c, s). Every
    // offered bundle must apply cleanly.
    for (const m of bundles) expect(applyMove(lastCardGame, s, m).ok).toBe(true)
    const topSuits = new Set(
      bundles.map((m) => {
        if (m.type !== 'play') return ''
        const cards = [m.card, ...(m.extraCards ?? [])]
        return cards[cards.length - 1]!.suit
      }),
    )
    expect(topSuits.size).toBe(2)
    expect(topSuits.has('h')).toBe(false) // ♥ can't be left on top (only legal lead)
  })

  it('a triplet that empties the hand wins the round', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 9, suit: 'h' }],
      hands: {
        0: [{ rank: 9, suit: 'h' }, { rank: 9, suit: 'c' }, { rank: 9, suit: 's' }],
        1: [{ rank: 3, suit: 'c' }],
        2: [{ rank: 4, suit: 'd' }],
      },
    }
    const r = applyMove(lastCardGame, s, {
      type: 'play',
      seat: 0,
      card: { rank: 9, suit: 'h' },
      extraCards: [{ rank: 9, suit: 'c' }, { rank: 9, suit: 's' }],
    } as LastCardMove)
    expect(r.ok).toBe(true)
    const after = (r as { state: LastCardState }).state
    expect(after.roundWinner).toBe(0)
  })

  it('never offers a multi-play whose LEAD is illegal (every legal move applies)', () => {
    // Pair of Kings where only the ♦ King can legally lead onto a ♦ demand.
    // The old top-suit generation offered {lead: 13♣, top: 13♦} — an illegal
    // lead — which the reducer rejected, stalling bot games.
    const base = init()
    const s: LastCardState = {
      ...base,
      activeSeat: 0,
      activeSuit: 'd',
      discardPile: [{ rank: 12, suit: 'd' }],
      hands: {
        0: [{ rank: 13, suit: 'c' }, { rank: 13, suit: 'd' }, { rank: 2, suit: 's' }],
        1: [{ rank: 8, suit: 'c' }],
        2: [{ rank: 8, suit: 'h' }],
      },
    }
    const moves = lastCardGame.getLegalMoves(s, 0)
    // EVERY legal move must actually apply (no illegal lead slips through).
    for (const m of moves) {
      const r = applyMove(lastCardGame, s, m)
      expect(r.ok, `move ${JSON.stringify(m)} should be applicable`).toBe(true)
    }
    // And the King-pair IS offered (via the legal ♦ lead), both top orderings.
    const pairMoves = moves.filter(
      (m) => m.type === 'play' && m.card.rank === 13 && (m.extraCards?.length ?? 0) === 1,
    )
    expect(pairMoves.length).toBeGreaterThan(0)
  })
})

describe('Last Card — reshuffle & win', () => {
  it('reshuffles the discard (keeping top) when the draw pile empties', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      drawPile: [],
      discardPile: [
        { rank: 5, suit: 'h' },
        { rank: 6, suit: 'c' },
        { rank: 7, suit: 'd' },
        { rank: 9, suit: 's' },
      ],
      hands: { 0: [{ rank: 13, suit: 'c' }], 1: [{ rank: 9, suit: 'c' }], 2: [{ rank: 9, suit: 'd' }] },
    }
    // Seat 0 can't play 13c on 5h → draw forces a reshuffle.
    const r = applyMove(lastCardGame, s, { type: 'draw', seat: 0 } as LastCardMove)
    expect(r.ok).toBe(true)
    const after = (r as { state: LastCardState }).state
    // Top discard preserved; the other 3 discards reshuffled into draw, minus
    // the one card just drawn.
    expect(after.discardPile[after.discardPile.length - 1]).toEqual({ rank: 9, suit: 's' })
    expect(after.drawPile.length + handCount(after, 0)).toBe(1 + 3) // drawn + remaining stock
  })

  it('emptying your hand wins the round and tallies penalties', () => {
    let s = init()
    s = {
      ...s,
      activeSeat: 0,
      activeSuit: 'h',
      discardPile: [{ rank: 5, suit: 'h' }],
      hands: {
        0: [{ rank: 4, suit: 'h' }],
        1: [{ rank: 13, suit: 'c' }, { rank: 1, suit: 'd' }], // K(10) + A(1) = 11
        2: [{ rank: 3, suit: 'd' }], // 3
      },
    }
    const r = applyMove(lastCardGame, s, { type: 'play', seat: 0, card: { rank: 4, suit: 'h' } } as LastCardMove)
    expect(r.ok).toBe(true)
    const after = (r as { state: LastCardState }).state
    expect(after.phase).toBe('finished')
    expect(after.roundWinner).toBe(0)
    const scores = lastCardGame.getScores(after)
    expect(scores.bySeat[1]).toBe(11)
    expect(scores.bySeat[2]).toBe(3)
    expect(scores.winners).toEqual([0])
  })
})

describe('Last Card — engine guarantees', () => {
  it('rejects out-of-turn and illegal moves', () => {
    const s = init()
    expect(applyMove(lastCardGame, s, { type: 'play', seat: 1, card: s.hands[1]![0]! } as LastCardMove).ok).toBe(false)
    const offSuit: Card = { rank: 13, suit: 'c' }
    const bad = applyMove(lastCardGame, { ...s, hands: { ...s.hands, 0: [offSuit] }, activeSuit: 'h', discardPile: [{ rank: 5, suit: 'h' }] }, { type: 'play', seat: 0, card: offSuit } as LastCardMove)
    expect(bad.ok).toBe(false)
  })

  it('is deterministic: same seed + move log replays identically', () => {
    const a = init('determinism')
    const b = init('determinism')
    expect(a).toEqual(b)
    // A short scripted log using draws (always legal).
    const log: LastCardMove[] = [
      { type: 'draw', seat: 0 },
      { type: 'draw', seat: 1 },
      { type: 'draw', seat: 2 },
    ]
    const ra = replay(lastCardGame, a, log)
    const rb = replay(lastCardGame, b, log)
    expect(ra).toEqual(rb)
  })

  it('redactFor hides identities but preserves opponent hand & draw counts', () => {
    const s = init()
    const view = lastCardGame.redactFor(s, 0)
    // Own hand is fully visible.
    expect(view.hands[0]!.length).toBe(7)
    // Opponent hand count is preserved (for backs + draw animations), but the
    // contents are face-down placeholders, not the real cards.
    expect(view.hands[1]!.length).toBe(7)
    expect(view.hands[1]!.every((c) => c.rank === 1 && c.suit === 'c')).toBe(true)
    expect(view.hands[1]).not.toEqual(s.hands[1])
    // Draw pile count preserved, identities hidden.
    expect(view.drawPile.length).toBe(s.drawPile.length)
    expect(view.drawPile.every((c) => c.rank === 1 && c.suit === 'c')).toBe(true)
  })
})
