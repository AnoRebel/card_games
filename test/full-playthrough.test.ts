import { describe, it, expect } from 'vitest'
import type {
  BaseGameState,
  BaseMove,
  GameModule,
  Player,
  ScoreResult,
} from '@card-games/engine-core'
import { lastCardGame, defaultLastCardConfig } from '@card-games/game-last-card'
import { albastiniGame, defaultAlbastiniConfig } from '@card-games/game-albastini'
import { LocalTransport } from '../app/transports/LocalTransport'

function makePlayers(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, seat: i }))
}

// Drive an ALL-BOT game to completion (human seat 0 also auto-plays the first
// legal move). Returns the final scores, or null if it didn't terminate.
async function playOut<S extends BaseGameState, M extends BaseMove, C>(
  game: GameModule<S, M, C>,
  config: C,
  players: Player[],
  seed: string,
): Promise<ScoreResult | null> {
  const t = new LocalTransport({
    game,
    players,
    config,
    seed,
    humanSeats: [0],
    botDelayMs: 0,
    now: () => '2026-01-01T00:00:00.000Z',
  })
  try {
    for (let i = 0; i < 5000; i++) {
      const v = t.getView()
      if (v.scores) return v.scores
      if (v.isMyTurn && v.legalMoves.length) {
        const res = await t.submitMove(v.legalMoves[0]!)
        // A rejected move would signal a bad legal-move set — fail loudly.
        if (!res.ok) throw new Error(`move rejected: ${res.error}`)
      } else {
        await new Promise((r) => setTimeout(r, 0)) // let the bot timer flush
      }
    }
    return null
  } finally {
    t.destroy()
  }
}

function assertValidScores(scores: ScoreResult | null, players: Player[]) {
  expect(scores).not.toBeNull()
  const s = scores!
  expect(s.winners.length).toBeGreaterThanOrEqual(1)
  // Every winner is a real seat; every seat has a score entry.
  for (const w of s.winners) expect(players.some((p) => p.seat === w)).toBe(true)
  for (const p of players) expect(typeof s.bySeat[p.seat]).toBe('number')
}

const SEEDS = ['alpha', 'bravo', 'charlie']

describe('Full playthrough — Last Card (all player counts + variants)', () => {
  for (const n of [2, 3, 4, 5, 6]) {
    for (const multi of [true, false]) {
      it(`${n}p, multiSameRank=${multi} finishes with a winner`, async () => {
        const players = makePlayers(n)
        for (const seed of SEEDS) {
          const scores = await playOut(
            lastCardGame,
            { ...defaultLastCardConfig(), allowMultiSameRank: multi },
            players,
            `lc-${n}-${multi}-${seed}`,
          )
          assertValidScores(scores, players)
        }
      }, 30000)
    }
  }
})

describe('Full playthrough — Albastini (all player counts + variants)', () => {
  for (const n of [2, 3, 4, 6]) {
    for (const bidding of [true, false]) {
      it(`${n}p, bidding=${bidding} finishes with scores`, async () => {
        const players = makePlayers(n)
        for (const seed of SEEDS) {
          const scores = await playOut(
            albastiniGame,
            { ...defaultAlbastiniConfig(), enableBidding: bidding },
            players,
            `ab-${n}-${bidding}-${seed}`,
          )
          assertValidScores(scores, players)
        }
      }, 30000)
    }
  }
})
