/**
 * Last Card rules engine: dealing, legal-move generation, the reducer, and
 * scoring. Pure and deterministic — randomness flows through the engine RNG.
 */

import {
  type Card,
  type Player,
  type ReducerResult,
  type Seat,
  type Suit,
  cardId,
  createRng,
  nextSeat,
  shuffle,
  standardDeck,
} from '@card-games/engine-core'
import { type LastCardConfig, cardPenaltyValue, defaultLastCardConfig } from './config'
import type { LastCardMove, LastCardState } from './state'

const isPickup = (c: Card, cfg: LastCardConfig) =>
  cfg.pickupCards.find((p) => p.rank === c.rank)
const isSkip = (c: Card, cfg: LastCardConfig) => cfg.skipCards.includes(c.rank)
const isReverse = (c: Card, cfg: LastCardConfig) =>
  cfg.reverseCards.includes(c.rank)
const isSuitChange = (c: Card, cfg: LastCardConfig) =>
  cfg.suitChangeCards.includes(c.rank)

/**
 * Is `hand` a "last card(s)" state — i.e. it can be emptied in ONE more play,
 * so the player must call? That's a single card, or (when multi same-rank plays
 * are allowed) two-or-more cards that are ALL the same rank (a pair/triplet the
 * player will dump together next turn).
 */
function isLastGroup(hand: readonly Card[], cfg: LastCardConfig): boolean {
  if (hand.length === 1) return true
  if (!cfg.allowMultiSameRank || hand.length < 2) return false
  const rank = hand[0]!.rank
  return hand.every((c) => c.rank === rank)
}

/** Top discard card (the pile is never empty during play). */
function topDiscard(state: LastCardState): Card {
  const top = state.discardPile[state.discardPile.length - 1]
  if (!top) throw new Error('Last Card: empty discard pile during play')
  return top
}

/** Can `card` be legally played onto the current table state? */
export function canPlay(state: LastCardState, card: Card): boolean {
  const cfg = state.config
  const top = topDiscard(state)

  // While a pickup penalty is pending, only a matching pickup card may be
  // played (to stack); otherwise the seat must draw the penalty.
  if (state.pendingPickup > 0) {
    return cfg.allowPickupStacking && isPickup(card, cfg) !== undefined
  }

  // Suit-change (wild) cards are always playable.
  if (isSuitChange(card, cfg)) return true

  // Otherwise match the active suit or the top card's rank.
  return card.suit === state.activeSuit || card.rank === top.rank
}

/** Deal a fresh round into `state` fields (mutates the passed draft). */
function dealRound(
  players: Player[],
  config: LastCardConfig,
  rng: LastCardState['rng'],
): Pick<
  LastCardState,
  'hands' | 'drawPile' | 'discardPile' | 'activeSuit' | 'rng'
> {
  const shuffled = shuffle(standardDeck(), rng)
  let deck = shuffled.items
  let r = shuffled.state

  const hands: Record<Seat, Card[]> = {}
  for (const p of players) hands[p.seat] = []
  for (let i = 0; i < config.handSize; i++) {
    for (const p of players) {
      hands[p.seat]!.push(deck.shift() as Card)
    }
  }

  // Turn the starting card; optionally re-draw past action cards.
  let start = deck.shift() as Card
  if (config.redrawActionStart) {
    const action = (c: Card) =>
      isPickup(c, config) !== undefined ||
      isSkip(c, config) ||
      isReverse(c, config) ||
      isSuitChange(c, config)
    const buried: Card[] = []
    while (action(start) && deck.length > 0) {
      buried.push(start)
      start = deck.shift() as Card
    }
    // Bury the skipped action cards back into the deck (then reshuffle).
    if (buried.length) {
      const res = shuffle([...deck, ...buried], r)
      deck = res.items
      r = res.state
    }
  }

  return {
    hands,
    drawPile: deck,
    discardPile: [start],
    activeSuit: start.suit,
    rng: r,
  }
}

/** Build the initial Last Card state. */
export function createInitialState(
  config: LastCardConfig,
  players: Player[],
  seed: string | number,
): LastCardState {
  const rng = createRng(seed)
  const dealt = dealRound(players, config, rng)
  const cumulativeScores: Record<Seat, number> = {}
  for (const p of players) cumulativeScores[p.seat] = 0

  return {
    gameId: 'last-card',
    config,
    rng: dealt.rng,
    players,
    activeSeat: players[0]!.seat,
    phase: 'playing',
    version: 0,
    hands: dealt.hands,
    drawPile: dealt.drawPile,
    discardPile: dealt.discardPile,
    activeSuit: dealt.activeSuit,
    direction: 1,
    pendingPickup: 0,
    declaredLastCard: null,
    awaitingCall: null,
    round: 0,
    cumulativeScores,
    roundWinner: null,
  }
}

/** Reshuffle the discard pile (except its top) back into the draw pile. */
function refillDrawPile(state: LastCardState): {
  drawPile: Card[]
  discardPile: Card[]
  rng: LastCardState['rng']
} {
  if (state.drawPile.length > 0 || state.discardPile.length <= 1) {
    return { drawPile: state.drawPile, discardPile: state.discardPile, rng: state.rng }
  }
  const top = state.discardPile[state.discardPile.length - 1]!
  const rest = state.discardPile.slice(0, -1)
  const res = shuffle(rest, state.rng)
  return { drawPile: res.items, discardPile: [top], rng: res.state }
}

const playerCount = (state: LastCardState) => state.players.length

/** Legal moves for `seat`. */
export function getLegalMoves(state: LastCardState, seat: Seat): LastCardMove[] {
  if (state.phase === 'finished') return []

  // A seat that reduced to its last card(s) (a single card, or one same-rank
  // group) but hasn't declared may call "Last Card" OUT OF TURN — before the
  // next player acts and closes the window. `awaitingCall` is only set by the
  // reducer for a genuine last-group, so gating on it is sufficient. Without
  // this, declaring is only possible atomically with the play → a plain play
  // guaranteed the missed-call penalty.
  const declareMoves: LastCardMove[] =
    state.config.requireLastCardCall && state.awaitingCall === seat
      ? [{ type: 'declare-last-card', seat }]
      : []

  // Off-turn: the only thing you may do is call your last card.
  if (state.activeSeat !== seat) return declareMoves

  const hand = state.hands[seat] ?? []
  const moves: LastCardMove[] = [...declareMoves]

  const isAction = (c: Card) =>
    isPickup(c, state.config) !== undefined ||
    isSkip(c, state.config) ||
    isReverse(c, state.config) ||
    isSuitChange(c, state.config)

  const playable = hand.filter((c) => {
    if (!canPlay(state, c)) return false
    // You can't go out on an action card unless the variant allows it.
    if (hand.length === 1 && isAction(c) && !state.config.allowActionCardFinish) {
      return false
    }
    return true
  })
  // Same-rank duplicates in hand (for pair/triplet/… plays).
  const sameRank = (lead: Card) =>
    hand.filter((c) => c.rank === lead.rank && cardId(c) !== cardId(lead))

  /** Push play move(s) for a lead card, optionally bundling extra same-rank cards. */
  const pushPlay = (card: Card, extraCards: Card[]) => {
    // Does this play leave a "last card(s)" hand (a single card, or one same-rank
    // group)? If so, offer declaring alongside the play.
    const playedIds = new Set([cardId(card), ...extraCards.map(cardId)])
    const remainder = hand.filter((c) => !playedIds.has(cardId(c)))
    const willReachLast =
      state.config.requireLastCardCall &&
      remainder.length >= 1 &&
      isLastGroup(remainder, state.config)
    const base = { type: 'play' as const, seat, card, ...(extraCards.length ? { extraCards } : {}) }
    if (isSuitChange(card, state.config)) {
      for (const suit of ['c', 's', 'h', 'd'] as Suit[]) {
        moves.push({ ...base, chosenSuit: suit })
        if (willReachLast) moves.push({ ...base, chosenSuit: suit, declareLastCard: true })
      }
    } else {
      moves.push(base)
      if (willReachLast) moves.push({ ...base, declareLastCard: true })
    }
  }

  const multiEmittedRanks = new Set<number>()
  for (const card of playable) {
    pushPlay(card, [])
    // Multi-same-rank: offer playing ALL copies of this rank together (the
    // common UX). Emit the bundle options once per rank (not once per copy).
    if (state.config.allowMultiSameRank && !multiEmittedRanks.has(card.rank)) {
      const extras = sameRank(card)
      if (extras.length) {
        multiEmittedRanks.add(card.rank)
        // Don't offer a multi-play that would end on a forbidden action card
        // (the win check below uses the same allowActionCardFinish gate).
        const endsOnAction =
          hand.length === 1 + extras.length &&
          isAction(card) &&
          !state.config.allowActionCardFinish
        if (endsOnAction) continue
        if (isSuitChange(card, state.config)) {
          // Wilds nominate the suit explicitly; a single bundle suffices.
          pushPlay(card, extras)
        } else {
          const group = [card, ...extras]
          // Play the whole same-rank group. The TOP (last-played) card sets the
          // active suit, so we offer one bundle per distinct top-suit. Two hard
          // constraints: (1) the LEAD (first card) must be a legal play — same
          // rank does NOT make every card a legal lead (a 9♣ can't lead onto a
          // ♦ demand); (2) to leave suit `s` on top there must be a suit-`s`
          // card to place LAST. If the only legal lead is also the only suit-`s`
          // card, that top-suit is infeasible (can't be both first and last).
          const legalLeads = group.filter((c) => canPlay(state, c))
          const seenTopSuit = new Set<string>()
          for (const top of group) {
            if (seenTopSuit.has(top.suit)) continue
            // Need a legal lead distinct from the card we want on top (so `top`
            // can be played LAST). If none, this top-suit is infeasible.
            const lead = legalLeads.find((c) => cardId(c) !== cardId(top))
            if (!lead) continue
            seenTopSuit.add(top.suit)
            const middle = group.filter(
              (c) => cardId(c) !== cardId(top) && cardId(c) !== cardId(lead),
            )
            pushPlay(lead, [...middle, top])
          }
        }
      }
    }
  }

  // Drawing is always available as the fallback action.
  moves.push({ type: 'draw', seat })

  return moves
}

function clone(state: LastCardState): LastCardState {
  return {
    ...state,
    hands: Object.fromEntries(
      Object.entries(state.hands).map(([s, h]) => [s, [...h]]),
    ) as Record<Seat, Card[]>,
    drawPile: [...state.drawPile],
    discardPile: [...state.discardPile],
    cumulativeScores: { ...state.cumulativeScores },
  }
}

/** Compute penalty scores for a finished round and fold into cumulative. */
function tallyRound(state: LastCardState, winner: Seat): Record<Seat, number> {
  const cumulative = { ...state.cumulativeScores }
  for (const p of state.players) {
    if (p.seat === winner) continue
    const hand = state.hands[p.seat] ?? []
    cumulative[p.seat] =
      (cumulative[p.seat] ?? 0) +
      hand.reduce((sum, c) => sum + cardPenaltyValue(c.rank), 0)
  }
  return cumulative
}

/** The reducer. */
export function reducer(
  state: LastCardState,
  move: LastCardMove,
): ReducerResult<LastCardState> {
  if (state.phase === 'finished') {
    return { ok: false, error: 'Round is over', state }
  }
  const cfg = state.config
  const count = playerCount(state)

  switch (move.type) {
    case 'draw': {
      const next = clone(state)

      // If a pickup penalty is pending and the seat draws, they take it all.
      const toDraw = next.pendingPickup > 0 ? next.pendingPickup : 1
      next.pendingPickup = 0

      for (let i = 0; i < toDraw; i++) {
        if (next.drawPile.length === 0) {
          const refilled = refillDrawPile(next)
          next.drawPile = refilled.drawPile
          next.discardPile = refilled.discardPile
          next.rng = refilled.rng
          if (next.drawPile.length === 0) break // nothing left to draw
        }
        const card = next.drawPile.pop()
        if (card) next.hands[move.seat]!.push(card)
      }

      // Resolve any pending missed-call penalty window closing on this action.
      applyMissedCall(next, move.seat)

      // Drawing ends the turn (single-draw rule) unless draw-until-playable
      // leaves them a play — for simplicity we end the turn after drawing the
      // required card(s); the UI re-prompts on their next turn.
      next.declaredLastCard =
        next.declaredLastCard === move.seat ? null : next.declaredLastCard
      next.activeSeat = nextSeat(move.seat, count, next.direction)
      return { ok: true, state: next }
    }

    case 'declare-last-card': {
      const next = clone(state)
      // Valid for a single card OR one same-rank group (pair/triplet).
      if (isLastGroup(next.hands[move.seat] ?? [], cfg)) {
        next.declaredLastCard = move.seat
        if (next.awaitingCall === move.seat) next.awaitingCall = null
      }
      return { ok: true, state: next }
    }

    case 'pass': {
      const next = clone(state)
      applyMissedCall(next, move.seat)
      next.activeSeat = nextSeat(move.seat, count, next.direction)
      return { ok: true, state: next }
    }

    case 'play': {
      const hand = state.hands[move.seat] ?? []
      const idx = hand.findIndex((c) => cardId(c) === cardId(move.card))
      if (idx === -1) return { ok: false, error: 'Card not in hand', state }
      if (!canPlay(state, move.card)) {
        return { ok: false, error: 'Card does not match', state }
      }
      if (isSuitChange(move.card, cfg) && !move.chosenSuit) {
        return { ok: false, error: 'Must nominate a suit', state }
      }

      // Validate any bundled same-rank cards (pair/triplet/…).
      const extras = move.extraCards ?? []
      if (extras.length && !cfg.allowMultiSameRank) {
        return { ok: false, error: 'Multi-card plays are not allowed', state }
      }
      const extraIdxs: number[] = []
      const usedIds = new Set<string>([cardId(move.card)])
      for (const ex of extras) {
        if (ex.rank !== move.card.rank) {
          return { ok: false, error: 'Extra cards must match the lead rank', state }
        }
        if (usedIds.has(cardId(ex))) {
          return { ok: false, error: 'Duplicate card in play', state }
        }
        const i = hand.findIndex((c) => cardId(c) === cardId(ex))
        if (i === -1) return { ok: false, error: 'Extra card not in hand', state }
        usedIds.add(cardId(ex))
        extraIdxs.push(i)
      }

      // All cards played this turn (lead first).
      const played: Card[] = [move.card, ...extras]

      const next = clone(state)

      // A new player's action closes the prior player's missed-call window.
      applyMissedCall(next, move.seat)

      // Remove every played card from hand (by id) and discard them in order.
      const playedIds = new Set(played.map((c) => cardId(c)))
      next.hands[move.seat] = next.hands[move.seat]!.filter(
        (c) => !playedIds.has(cardId(c)),
      )
      for (const c of played) next.discardPile.push(c)

      // Active suit: nominated suit for wilds, else the (last) played card's suit.
      const topPlayed = played[played.length - 1]!
      next.activeSuit =
        isSuitChange(move.card, cfg) && move.chosenSuit
          ? move.chosenSuit
          : topPlayed.suit

      // Direction / pickup / skip effects apply PER played card.
      for (const c of played) {
        if (isReverse(c, cfg)) next.direction = (next.direction * -1) as 1 | -1
        const pk = isPickup(c, cfg)
        if (pk) next.pendingPickup += pk.amount
      }

      // Last-card declaration handling. "Last card(s)" = a single card OR one
      // same-rank group (pair/triplet) that can be dumped together next turn.
      const remainingHand = next.hands[move.seat]!
      const remaining = remainingHand.length
      if (remaining >= 1 && isLastGroup(remainingHand, cfg) && cfg.requireLastCardCall) {
        if (move.declareLastCard) {
          next.declaredLastCard = move.seat
          next.awaitingCall = null
        } else {
          next.awaitingCall = move.seat // penalty if not declared before next act
        }
      }

      // Win check.
      if (remaining === 0) {
        next.roundWinner = move.seat
        // The winner's hand is empty; any obligation their final card created
        // dies with the round.
        next.pendingPickup = 0
        next.awaitingCall = null
        next.cumulativeScores = tallyRound(next, move.seat)
        if (next.round + 1 >= cfg.rounds) {
          next.phase = 'finished'
          next.activeSeat = null
          return { ok: true, state: next }
        }
        // Start the next round, rotating the dealer/first player.
        const reseed = createRng(next.rng.seed ^ (next.round + 1))
        const dealt = dealRound(next.players, cfg, reseed)
        next.hands = dealt.hands
        next.drawPile = dealt.drawPile
        next.discardPile = dealt.discardPile
        next.activeSuit = dealt.activeSuit
        next.rng = dealt.rng
        next.round += 1
        next.pendingPickup = 0
        next.direction = 1
        next.declaredLastCard = null
        next.awaitingCall = null
        next.roundWinner = null
        next.activeSeat = next.players[next.round % count]!.seat
        return { ok: true, state: next }
      }

      // Advance turn, skipping once per skip card played (each skip = +1 step).
      const skips = played.filter((c) => isSkip(c, cfg)).length
      const steps = 1 + skips
      next.activeSeat = stepSeat(move.seat, count, steps, next.direction)
      return { ok: true, state: next }
    }
  }
}

function stepSeat(
  seat: Seat,
  count: number,
  steps: number,
  dir: 1 | -1,
): Seat {
  let s = seat
  for (let i = 0; i < steps; i++) s = nextSeat(s, count, dir)
  return s
}

/**
 * If a previous seat was awaiting a "Last Card" declaration and the window has
 * now closed (a different seat is acting), apply the missed-call penalty.
 */
function applyMissedCall(state: LastCardState, actingSeat: Seat): void {
  if (state.awaitingCall === null) return
  if (state.awaitingCall === actingSeat) return // their own follow-up, no close yet
  const offender = state.awaitingCall
  for (let i = 0; i < state.config.missedCallPenalty; i++) {
    if (state.drawPile.length === 0) {
      const refilled = refillDrawPile(state)
      state.drawPile = refilled.drawPile
      state.discardPile = refilled.discardPile
      state.rng = refilled.rng
      if (state.drawPile.length === 0) break
    }
    const card = state.drawPile.pop()
    if (card) state.hands[offender]!.push(card)
  }
  state.awaitingCall = null
}

export { defaultLastCardConfig }
