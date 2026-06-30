<script setup lang="ts">
/**
 * Last Card table — themed felt, gesture (swipe-up to play) + tap, anime.js
 * deal/flip/celebrate, suit chooser, move log, restart.
 */
import { cardId, cardShort, type Card, type Suit } from '@card-games/engine-core'
import type {
  LastCardMove,
  LastCardState,
} from '@card-games/game-last-card'
import type { GameTransport } from '~/transports/types'

const props = defineProps<{
  transport: GameTransport<LastCardState, LastCardMove>
  canRematch?: boolean
}>()
const emit = defineEmits<{ restart: []; newGame: []; exit: [] }>()

const session = useGameSession(props.transport)
const { state, legalMoves, isMyTurn, scores, players, viewerSeat, ready } = session

const lc = computed(() => (state.value ?? {}) as LastCardState)
const hasState = computed(() => ready.value && !!lc.value.hands)
const topDiscard = computed(
  () => lc.value.discardPile?.[lc.value.discardPile.length - 1] ?? null,
)
const myHand = computed(() =>
  viewerSeat.value !== null ? (lc.value.hands?.[viewerSeat.value] ?? []) : [],
)
const modalUi = useThemedModalUi()
const playableIds = computed(() => {
  const ids = new Set<string>()
  for (const m of legalMoves.value) if (m.type === 'play') ids.add(cardId(m.card))
  return ids
})
const opponents = computed(() => players.value.filter((p) => p.seat !== viewerSeat.value))
const suitSym = (s: string) => ({ c: '♣', s: '♠', h: '♥', d: '♦' })[s] ?? s
const activeName = computed(
  () => players.value.find((p) => p.seat === lc.value.activeSeat)?.name ?? '—',
)
const handSize = (seat: number) => lc.value.hands?.[seat]?.length ?? 0

// --- move log ---------------------------------------------------------------
const log = useMoveLog<LastCardState>((prev, next) => {
  if (!prev || !next.discardPile) return null
  if (next.discardPile.length > prev.discardPile.length) {
    const card = next.discardPile[next.discardPile.length - 1]!
    const who = players.value.find((p) => prev.activeSeat === p.seat)?.name ?? '?'
    return { who, action: 'played', card: cardShort(card), icon: 'i-lucide-play' }
  }
  for (const p of players.value) {
    const a = prev.hands?.[p.seat]?.length ?? 0
    const b = next.hands?.[p.seat]?.length ?? 0
    if (b > a) return { who: p.name, action: `drew ${b - a}`, icon: 'i-lucide-download' }
  }
  if (next.roundWinner != null && next.roundWinner !== prev.roundWinner) {
    const w = players.value.find((p) => p.seat === next.roundWinner)?.name ?? '?'
    return { who: w, action: 'went out!', icon: 'i-lucide-flag' }
  }
  return null
})

// --- animation refs ---------------------------------------------------------
const discardRef = ref<HTMLElement | null>(null)
const suitRef = ref<HTMLElement | null>(null)
const tableRef = ref<HTMLElement | null>(null)
const drawRef = ref<HTMLElement | null>(null)
const drawCardRef = ref<HTMLElement | null>(null)
const handRef = ref<{
  cardEl: (id: string) => HTMLElement | null
  rootEl: () => HTMLElement | null
} | null>(null)

// Per-seat anchor elements (opponent pills) so we can fly cards to/from the
// seat that actually played or drew — not just the local player.
const oppEls = new Map<number, HTMLElement>()
function setOppEl(seat: number, node: Element | null) {
  if (node) oppEls.set(seat, node as HTMLElement)
  else oppEls.delete(seat)
}
/** Anchor for a seat: opponents use their pill; the viewer uses their hand's
 *  root DOM element (NOT the exposed component object — that has no rect). */
function seatAnchor(seat: number): HTMLElement | null {
  if (seat === viewerSeat.value) return handRef.value?.rootEl() ?? null
  return oppEls.get(seat) ?? null
}

// We drive plays/draws off STATE DIFFS so every player (humans AND bots) gets
// animated — the local player's own play is flown optimistically in the click
// handler, and `flownByLocal` suppresses the duplicate diff-driven flight.
let flownByLocal: string | null = null

watch(topDiscard, (top, prev) => {
  if (!top || (prev && cardId(top) === cardId(prev))) return
  const id = cardId(top)
  nextTick(() => {
    if (!discardRef.value) return
    // Local player's card was already flown from the hand → just pop it.
    if (flownByLocal === id) {
      flownByLocal = null
      playCard(discardRef.value)
      return
    }
    // Otherwise fly it from the seat that just played (opponent / bot).
    const from = lastPlayerSeat.value != null ? seatAnchor(lastPlayerSeat.value) : null
    if (from) flyCard(from, discardRef.value).then(() => playCard(discardRef.value!))
    else playCard(discardRef.value)
  })
})

// Track the seat that played most recently (the seat active *before* the change).
const lastPlayerSeat = ref<number | null>(null)
let prevActive: number | null = null
const prevHands: Record<number, number> = {}
// Skip animating the very first state (initial deal) — only refills mid-game.
let primedHands = false

// Shuffle the draw pile when a fresh deal happens (round start: draw pile jumps
// up after having been depleted/empty, or the first deal of the match).
watch(
  () => lc.value.drawPile?.length ?? 0,
  (n, prev) => {
    if (n > (prev ?? 0) + 1 && drawRef.value) shuffle(drawRef.value)
  },
)
watch(() => lc.value.activeSuit, () => {
  if (suitRef.value) suitFlourish(suitRef.value)
})
const showGameOver = ref(false)
watch(scores, (s) => {
  if (!s) { showGameOver.value = false; return } // rematch/new round → close it
  nextTick(() => {
    const won = s.winners.includes(viewerSeat.value ?? -1)
    if (won) {
      confetti()
      if (tableRef.value) burst(tableRef.value)
    } else if (tableRef.value) {
      loseShake(tableRef.value)
    }
    // Let the celebration breathe before the scoreboard slides in.
    setTimeout(() => { showGameOver.value = true }, 700)
  })
})

// Diff-driven effects on every state update: remember who was active (the
// player), and fly drawn cards from the draw pile to the drawing seat.
props.transport.onChange((v) => {
  const next = v.state as LastCardState | null
  if (next) {
    lastPlayerSeat.value = prevActive
    // Draw detection: any seat whose hand grew → fly card(s) from the draw pile.
    for (const p of players.value) {
      const before = prevHands[p.seat] ?? 0
      const after = next.hands?.[p.seat]?.length ?? 0
      if (primedHands && after > before) animateDraw(p.seat, after - before)
      prevHands[p.seat] = after
    }
    prevActive = next.activeSeat ?? null
    primedHands = true
  }
  log.push(v.state)
})

function animateDraw(seat: number, count: number) {
  nextTick(() => {
    const to = seatAnchor(seat)
    const from = drawCardRef.value ?? drawRef.value
    if (from && to) {
      // A drawn card stays roughly card-sized at the hand (don't scale to the
      // hand row's full width).
      for (let i = 0; i < count; i++) flyCard(from, to, { scaleTo: 1 })
    }
  })
}

// --- play -------------------------------------------------------------------
const pendingSuitCard = ref<Card | null>(null)
const suitModalOpen = computed({
  get: () => pendingSuitCard.value !== null,
  set: (v: boolean) => { if (!v) pendingSuitCard.value = null },
})
const suits: { id: Suit; label: string }[] = [
  { id: 'h', label: '♥' }, { id: 'd', label: '♦' },
  { id: 'c', label: '♣' }, { id: 's', label: '♠' },
]

async function flyToDiscard(...cards: Card[]) {
  // Mark these cards as locally flown so the diff-driven watcher doesn't re-fly.
  flownByLocal = cardId(cards[cards.length - 1]!)
  for (const c of cards) {
    const src = handRef.value?.cardEl(cardId(c))
    if (src && discardRef.value) await flyCard(src, discardRef.value)
  }
}

/** All cards involved in a play move (lead + extras). */
function playedCards(m: LastCardMove): Card[] {
  if (m.type !== 'play') return []
  return [m.card, ...(m.extraCards ?? [])]
}
/** The top (suit-setting) card of a play = the last one played. */
function topOf(m: LastCardMove): Card | null {
  const cards = playedCards(m)
  return cards[cards.length - 1] ?? null
}

// Multi same-rank prompt. `single` plays one; `bundles` are the "play all"
// options (one per choosable top card when 3+ are held).
const pendingMulti = ref<{ card: Card; single: LastCardMove; bundles: LastCardMove[] } | null>(null)
// Second step: once "play all" is chosen with 3+ cards, pick which stays on top.
const choosingTop = ref(false)
const multiModalOpen = computed({
  get: () => pendingMulti.value !== null,
  set: (v: boolean) => { if (!v) { pendingMulti.value = null; choosingTop.value = false } },
})
const multiCount = computed(() => {
  const b = pendingMulti.value?.bundles[0]
  return b ? playedCards(b).length : 0
})
const suitSymOf = (s: string) => ({ c: '♣', s: '♠', h: '♥', d: '♦' })[s] ?? s

async function commitPlay(move: LastCardMove) {
  if (move.type !== 'play') return
  pendingMulti.value = null
  choosingTop.value = false
  await flyToDiscard(...playedCards(move))
  await session.play(move)
}

async function playCardMove(card: Card) {
  const plays = legalMoves.value.filter(
    (m) => m.type === 'play' && cardId(m.card) === cardId(card),
  )
  if (!plays.length) return

  // Suit-change cards: defer to the suit chooser (handles multi too once a suit
  // is picked, by preferring a bundled move).
  if (plays.some((m) => m.type === 'play' && m.chosenSuit)) {
    pendingSuitCard.value = card
    return
  }

  const bundles = plays.filter((m) => m.type === 'play' && (m.extraCards?.length ?? 0) > 0)
  const single = plays.find((m) => m.type === 'play' && !(m.extraCards?.length))
  if (bundles.length && single) {
    pendingMulti.value = { card, single, bundles }
    return
  }
  await commitPlay((bundles[0] ?? single ?? plays[0])!)
}

async function chooseMulti(all: boolean) {
  const p = pendingMulti.value
  if (!p) return
  if (!all) {
    await commitPlay(p.single)
    return
  }
  // One bundle option → play it. Multiple (3+ with distinct suits) → ask which
  // card stays on top.
  if (p.bundles.length <= 1) {
    await commitPlay(p.bundles[0]!)
  } else {
    choosingTop.value = true
  }
}

async function chooseTop(move: LastCardMove) {
  await commitPlay(move)
}

async function chooseSuit(suit: Suit) {
  const card = pendingSuitCard.value
  if (!card) return
  // Prefer a bundled same-rank move for this suit when available.
  const forSuit = legalMoves.value.filter(
    (m) => m.type === 'play' && cardId(m.card) === cardId(card) && m.chosenSuit === suit,
  )
  const move =
    forSuit.find((m) => m.type === 'play' && (m.extraCards?.length ?? 0) > 0) ??
    forSuit[0]
  pendingSuitCard.value = null
  if (move) await commitPlay(move)
}
async function draw() {
  const move = legalMoves.value.find((m) => m.type === 'draw')
  if (move) await session.play(move)
}
</script>

<template>
  <div v-if="!hasState" class="cg-surface rounded-2xl p-10 text-center space-y-2">
    <UIcon name="i-lucide-loader-circle" class="animate-spin text-2xl" />
    <p class="text-sm" :style="{ color: 'var(--cg-text-muted)' }">
      Waiting for the game to start…
    </p>
  </div>

  <div v-else class="space-y-3">
    <!-- Opponents -->
    <div class="flex flex-wrap gap-2 justify-center">
      <div
        v-for="opp in opponents"
        :key="opp.seat"
        :ref="(n) => setOppEl(opp.seat, n as Element | null)"
        :title="`${opp.name} — ${handSize(opp.seat)} cards`"
        class="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition"
        :class="lc.activeSeat === opp.seat ? 'cg-glow' : ''"
        :style="{
          background: 'var(--cg-surface)',
          border: '1px solid var(--cg-border)',
          outline: lc.activeSeat === opp.seat ? '2px solid var(--cg-accent)' : 'none',
        }"
      >
        <span class="font-medium">{{ opp.name }}</span>
        <span class="flex -space-x-3">
          <PlayingCard v-for="n in Math.min(handSize(opp.seat), 4)" :key="n" face-down :width="26" />
        </span>
        <span :style="{ color: 'var(--cg-text-muted)' }">{{ handSize(opp.seat) }}</span>
      </div>
    </div>

    <!-- Felt table -->
    <div
      ref="tableRef"
      class="relative rounded-2xl p-6 sm:p-10 flex items-center justify-center gap-8 sm:gap-14 overflow-hidden cg-felt min-h-[300px]"
      data-tour="table"
    >
      <div ref="drawRef" class="flex flex-col items-center gap-1">
        <div ref="drawCardRef">
          <CardPile
            :face-down="true"
            :count="lc.drawPile?.length ?? 0"
            :label="$t('game.draw')"
            :width="96"
            :selectable="isMyTurn"
            data-tour="draw"
            @activate="draw"
          />
        </div>
        <span class="text-[11px] font-medium text-white/80 inline-flex items-center gap-1">
          <UIcon name="i-lucide-layers" /> {{ $t('game.deckCount', { count: lc.drawPile?.length ?? 0 }) }}
        </span>
      </div>
      <div ref="discardRef" class="flex flex-col items-center gap-2" data-tour="discard">
        <CardPile :top="topDiscard" :count="lc.discardPile?.length ?? 0" :width="96" />
        <span ref="suitRef" class="text-sm font-semibold text-white/90 flex items-center gap-1.5">
          {{ $t('game.suit') }}: <span class="text-xl">{{ suitSym(lc.activeSuit) }}</span>
          <span v-if="lc.pendingPickup" class="ml-1 rounded-full bg-amber-400/90 text-amber-950 px-2 py-0.5">
            +{{ lc.pendingPickup }}
          </span>
        </span>
      </div>
    </div>

    <!-- Turn pill -->
    <div class="flex justify-center">
      <span
        class="text-sm font-semibold rounded-full px-4 py-1.5"
        :style="isMyTurn
          ? { background: 'var(--cg-accent)', color: 'var(--cg-accent-contrast)' }
          : { color: 'var(--cg-text-muted)' }"
      >
        {{ isMyTurn ? $t('game.yourTurn') : $t('game.waitingFor', { name: activeName }) }}
      </span>
    </div>

    <!-- Your hand, with a live card count -->
    <div class="flex items-center justify-center gap-1.5 text-xs font-medium" :style="{ color: 'var(--cg-text-muted)' }">
      <UIcon name="i-lucide-layers" />
      {{ $t('game.cardsInHand', { count: myHand.length }) }}
    </div>
    <GestureHand
      ref="handRef"
      :cards="myHand"
      :playable-ids="playableIds"
      :enabled="isMyTurn"
      :width="100"
      @play="playCardMove"
    />

    <!-- Suit chooser -->
    <UModal v-model:open="suitModalOpen" :title="$t('game.chooseSuit')" :ui="modalUi">
      <template #body>
        <div class="grid grid-cols-2 gap-3">
          <UButton
            v-for="s in suits"
            :key="s.id"
            size="xl"
            variant="outline"
            class="justify-center text-2xl"
            :class="s.id === 'h' || s.id === 'd' ? 'text-red-500' : ''"
            @click="chooseSuit(s.id)"
          >
            {{ s.label }}
          </UButton>
        </div>
      </template>
    </UModal>

    <!-- Multi same-rank chooser (pair / triplet / …) -->
    <UModal
      v-model:open="multiModalOpen"
      :title="choosingTop ? $t('game.chooseTopTitle') : $t('game.playMultipleTitle')"
      :ui="modalUi"
    >
      <template #body>
        <!-- Step 1: play one vs all -->
        <div v-if="!choosingTop" class="space-y-3">
          <p class="text-sm" :style="{ color: 'var(--cg-text-muted)' }">
            {{ $t('game.playMultipleBody', { count: multiCount }) }}
          </p>
          <div class="grid grid-cols-2 gap-3">
            <UButton size="lg" variant="outline" color="neutral" class="justify-center" @click="chooseMulti(false)">
              {{ $t('game.playOne') }}
            </UButton>
            <UButton size="lg" color="primary" class="justify-center" @click="chooseMulti(true)">
              {{ $t('game.playAll', { count: multiCount }) }}
            </UButton>
          </div>
        </div>

        <!-- Step 2: which card stays on top (sets the suit) -->
        <div v-else class="space-y-3">
          <p class="text-sm" :style="{ color: 'var(--cg-text-muted)' }">
            {{ $t('game.chooseTopBody') }}
          </p>
          <div class="flex flex-wrap gap-3 justify-center">
            <button
              v-for="(b, i) in pendingMulti?.bundles ?? []"
              :key="i"
              type="button"
              class="rounded-xl p-1 transition hover:-translate-y-1"
              :style="{ border: '2px solid var(--cg-border)' }"
              :title="`Top: ${topOf(b)?.rank}${suitSymOf(topOf(b)?.suit ?? '')}`"
              @click="chooseTop(b)"
            >
              <PlayingCard v-if="topOf(b)" :card="topOf(b)!" :width="64" />
            </button>
          </div>
        </div>
      </template>
    </UModal>

    <!-- Move log (floating side panel) -->
    <MoveLogSlideover :entries="log.entries.value" />

    <!-- End-of-game scoreboard -->
    <GameOverDialog
      v-if="scores"
      v-model:open="showGameOver"
      :scores="scores"
      :players="players"
      :viewer-seat="viewerSeat"
      game-id="last-card"
      :can-rematch="canRematch"
      @rematch="emit('restart')"
      @new-game="emit('newGame')"
      @exit="emit('exit')"
    />
  </div>
</template>
