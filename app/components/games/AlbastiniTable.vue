<script setup lang="ts">
/**
 * Albastini table — themed felt, gesture hand, trump + trick display, move log,
 * restart, anime.js. Trick-taking with otea bidding.
 */
import { cardId, cardShort, type Card } from '@card-games/engine-core'
import type {
  AlbastiniMove,
  AlbastiniState,
} from '@card-games/game-albastini'
import type { GameTransport } from '~/transports/types'

const props = defineProps<{
  transport: GameTransport<AlbastiniState, AlbastiniMove>
  canRematch?: boolean
}>()
const emit = defineEmits<{ restart: []; newGame: []; exit: [] }>()

const session = useGameSession(props.transport)
const { state, legalMoves, isMyTurn, scores, players, viewerSeat, ready } = session

// Defensive default so the template never reads undefined fields before the
// first server state arrives (online lobby) — the table is gated on `ready`.
const ab = computed(
  () =>
    (state.value ?? {}) as AlbastiniState & {
      currentTrick: AlbastiniState['currentTrick']
    },
)
const hasState = computed(() => ready.value && !!ab.value.hands)
const myHand = computed(() =>
  viewerSeat.value !== null ? (ab.value.hands?.[viewerSeat.value] ?? []) : [],
)
const trumpSym = computed(() =>
  ab.value.trump ? ({ c: '♣', s: '♠', h: '♥', d: '♦' })[ab.value.trump] : '—',
)
const playableIds = computed(() => {
  const ids = new Set<string>()
  for (const m of legalMoves.value)
    if (m.type === 'play' || m.type === 'bid') ids.add(cardId(m.card))
  return ids
})
const activeName = computed(
  () => players.value.find((p) => p.seat === ab.value.activeSeat)?.name ?? '—',
)
const opponents = computed(() => players.value.filter((p) => p.seat !== viewerSeat.value))
const handSize = (seat: number) => ab.value.hands?.[seat]?.length ?? 0
const eaten = (seat: number) => ab.value.taken?.[seat] ?? []
const stockCount = computed(() => ab.value.stock?.length ?? 0)

const log = useMoveLog<AlbastiniState>((prev, next) => {
  if (!prev || !next.currentTrick) return null
  if (next.currentTrick.length > prev.currentTrick.length) {
    const tp = next.currentTrick[next.currentTrick.length - 1]!
    const who = players.value.find((p) => p.seat === tp.seat)?.name ?? '?'
    return { who, action: 'played', card: cardShort(tp.card), icon: 'i-lucide-play' }
  }
  if (prev.currentTrick.length && !next.currentTrick.length) {
    for (const p of players.value) {
      if ((next.taken?.[p.seat]?.length ?? 0) > (prev.taken?.[p.seat]?.length ?? 0))
        return { who: p.name, action: 'ate the trick (Kula)', icon: 'i-lucide-utensils' }
    }
  }
  if (next.bids.length > prev.bids.length) {
    const b = next.bids[next.bids.length - 1]!
    const who = players.value.find((p) => p.seat === b.seat)?.name ?? '?'
    return { who, action: 'bid (otea)', card: cardShort(b.card), icon: 'i-lucide-gavel' }
  }
  return null
})
// --- animation refs (declared before the onChange closure that uses them) ---
const tableRef = ref<HTMLElement | null>(null)
const trumpRef = ref<HTMLElement | null>(null)
const trickRef = ref<HTMLElement | null>(null)
const stockRef = ref<HTMLElement | null>(null)
const handRef = ref<{
  cardEl: (id: string) => HTMLElement | null
  rootEl: () => HTMLElement | null
} | null>(null)

// Per-seat anchor (opponent pills) so opponents'/bots' plays fly from their
// position into the trick — not just the local player's.
const oppEls = new Map<number, HTMLElement>()
function setOppEl(seat: number, node: Element | null) {
  if (node) oppEls.set(seat, node as HTMLElement)
  else oppEls.delete(seat)
}
// Suppress the diff-driven flight for the card the local player just flew.
let flownByLocal: string | null = null

// Track who just ate a trick (their `taken` grew) so the trick can sweep toward
// the eater's pile, plus per-seat hand sizes for draw-from-stock animations.
const lastEater = ref<number | null>(null)
const prevTaken: Record<number, number> = {}
const prevHand: Record<number, number> = {}
let primedHands = false
props.transport.onChange((v) => {
  const next = v.state as AlbastiniState | null
  if (next?.taken) {
    for (const p of players.value) {
      const before = prevTaken[p.seat] ?? 0
      const after = next.taken?.[p.seat]?.length ?? 0
      if (after > before) lastEater.value = p.seat
      prevTaken[p.seat] = after
    }
  }
  if (next?.hands) {
    // Snapshot the viewer seat (hotseat flips it per turn).
    const viewer = viewerSeat.value
    for (const p of players.value) {
      const after = next.hands?.[p.seat]?.length ?? 0
      const before = prevHand[p.seat] ?? 0
      // Skip the very first state (initial deal) — only animate refills mid-game.
      if (primedHands && after > before && stockRef.value) {
        const toViewer = p.seat === viewer
        const to = toViewer ? (handRef.value?.rootEl() ?? null) : oppEls.get(p.seat) ?? null
        if (to) {
          const reps = after - before
          // Stock card (~48px) grows to ~hand card size for the viewer; stays
          // small for an opponent pill (auto-clamped).
          for (let i = 0; i < reps; i++) {
            flyCard(stockRef.value, to, toViewer ? { scaleTo: 1.9 } : {})
          }
        }
      }
      prevHand[p.seat] = after
    }
    primedHands = true
  }
  log.push(v.state)
})

// Shuffle flourish on a fresh deal. Keyed off the STOCK size jumping up (a
// stable, viewer-independent signal) rather than `myHand.length`, which swaps
// identity in offline hotseat when the viewer seat flips. Primed guard skips
// the initial deal so we don't wiggle on mount.
let primedStock = false
watch(
  () => ab.value.stock?.length ?? 0,
  (n, prev) => {
    if (primedStock && n > (prev ?? 0) + 1 && tableRef.value) shuffle(tableRef.value)
    primedStock = true
  },
)

// Eaten-cards viewer.
const showEaten = ref<number | null>(null)
const eatenModalOpen = computed({
  get: () => showEaten.value !== null,
  set: (v: boolean) => { if (!v) showEaten.value = null },
})

// Themed modal styling (so dialogs match the active theme).
const modalUi = useThemedModalUi()

watch(() => ab.value.trump, (t) => {
  if (t && trumpRef.value) {
    dealIn(trumpRef.value)
    suitFlourish(trumpRef.value)
  }
})
// Animate the newest trick card in / sweep on resolution. The currentTrick
// entries carry their seat, so we can fly opponents'/bots' cards from their
// pill into the trick area (the local player's own card is flown optimistically
// in onPlay and suppressed here via flownByLocal).
watch(() => ab.value.currentTrick?.length ?? 0, (n, prev) => {
  if (n > (prev ?? 0) && trickRef.value) {
    const tp = ab.value.currentTrick[n - 1]
    const id = tp ? cardId(tp.card) : null
    nextTick(() => {
      if (!trickRef.value) return
      const last = trickRef.value.lastElementChild as HTMLElement | null
      if (id && flownByLocal === id) {
        flownByLocal = null
        if (last) playCard(last)
        return
      }
      const from = tp ? oppEls.get(tp.seat) ?? null : null
      if (from && last) flyCard(from, last).then(() => playCard(last))
      else if (last) playCard(last)
    })
  } else if (prev && n === 0 && trickRef.value) {
    // Trick resolved → sweep the cards toward whoever ate them.
    const cards = Array.from(trickRef.value.children) as HTMLElement[]
    const eaterEl = lastEater.value != null ? oppEls.get(lastEater.value) ?? null : null
    if (eaterEl) {
      const a = trickRef.value.getBoundingClientRect()
      const b = eaterEl.getBoundingClientRect()
      sweepTo(cards, b.left + b.width / 2 - (a.left + a.width / 2), b.top + b.height / 2 - (a.top + a.height / 2))
    } else {
      // You ate it (no opponent pill) → sweep downward toward your eaten pile.
      sweepTo(cards, 0, 40)
    }
  }
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
    setTimeout(() => { showGameOver.value = true }, 700)
  })
})

// Host manually ended the game (no natural scores) → open the same dialog so
// remaining players get next-step options.
const endedBy = computed(
  () => (session.roomInfo.value as { endedBy?: string | null } | null)?.endedBy ?? null,
)
watch(endedBy, (name) => {
  if (name && !scores.value) showGameOver.value = true
  else if (!name && !scores.value) showGameOver.value = false // rematch cleared it
})

async function onPlay(card: Card) {
  const move = legalMoves.value.find(
    (m) => (m.type === 'play' || m.type === 'bid') && cardId(m.card) === cardId(card),
  )
  if (!move) return
  const src = handRef.value?.cardEl(cardId(card))
  if (src && trickRef.value) await flyCard(src, trickRef.value)
  // Mark flown before submit (local play may diff synchronously); clear on a
  // rejected move so a stale id can't mis-suppress a later opponent's fly.
  flownByLocal = cardId(card)
  const res = await session.play(move)
  if (!res.ok && flownByLocal === cardId(card)) flownByLocal = null
}
async function passBid() {
  const move = legalMoves.value.find((m) => m.type === 'pass-bid')
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
      <button
        v-for="opp in opponents"
        :key="opp.seat"
        :ref="(n) => setOppEl(opp.seat, n as Element | null)"
        type="button"
        :title="`${opp.name} — ${eaten(opp.seat).length} cards eaten`"
        class="flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition"
        :style="{
          background: 'var(--cg-surface)',
          border: '1px solid var(--cg-border)',
          outline: ab.activeSeat === opp.seat ? '2px solid var(--cg-accent)' : 'none',
        }"
        @click="showEaten = opp.seat"
      >
        <span class="font-medium">{{ opp.name }}</span>
        <span class="flex -space-x-3">
          <PlayingCard v-for="n in Math.min(handSize(opp.seat), 4)" :key="n" face-down :width="24" />
        </span>
        <span class="inline-flex items-center gap-0.5" :style="{ color: 'var(--cg-text-muted)' }" :title="$t('game.cardsInHand', { count: handSize(opp.seat) })">
          <UIcon name="i-lucide-layers" /> {{ handSize(opp.seat) }}
        </span>
        <span class="inline-flex items-center gap-0.5" :style="{ color: 'var(--cg-text-muted)' }" :title="`${eaten(opp.seat).length} eaten`">
          <UIcon name="i-lucide-utensils" /> {{ eaten(opp.seat).length }}
        </span>
      </button>
    </div>

    <!-- Felt table -->
    <div ref="tableRef" class="relative rounded-2xl p-6 sm:p-10 cg-felt flex flex-col items-center gap-5 overflow-hidden min-h-[340px]">
      <div class="flex items-center justify-center gap-6 flex-wrap">
        <div ref="trumpRef" class="flex items-center gap-2 text-white/90" data-tour="trump">
          <span class="text-xs font-semibold uppercase tracking-wide">{{ $t('game.trump') }}</span>
          <span class="text-3xl font-bold">{{ trumpSym }}</span>
          <PlayingCard v-if="ab.trumpCard" :card="ab.trumpCard" :width="60" />
        </div>
        <!-- Stock / deck with live count -->
        <div ref="stockRef" class="flex flex-col items-center gap-1" data-tour="stock">
          <CardPile :face-down="true" :count="stockCount" :width="48" />
          <span class="text-[11px] font-medium text-white/80 inline-flex items-center gap-1">
            <UIcon name="i-lucide-layers" /> {{ $t('game.deckCount', { count: stockCount }) }}
          </span>
        </div>
      </div>
      <div ref="trickRef" class="flex gap-3 min-h-36 items-end" data-tour="trick">
        <div
          v-for="tp in ab.currentTrick"
          :key="`${tp.seat}-${cardId(tp.card)}`"
          v-motion
          :initial="{ opacity: 0, y: 24, scale: 0.85 }"
          :enter="{ opacity: 1, y: 0, scale: 1 }"
          class="flex flex-col items-center gap-1"
        >
          <PlayingCard :card="tp.card" :width="78" />
          <span class="text-[11px] text-white/80">{{ players.find((p) => p.seat === tp.seat)?.name }}</span>
        </div>
        <p v-if="!ab.currentTrick.length" class="text-white/60 text-sm self-center">
          {{ $t('game.noCardsYet') }}
        </p>
      </div>
    </div>

    <!-- Turn pill + bid -->
    <div class="flex flex-col items-center gap-2">
      <span
        class="text-sm font-semibold rounded-full px-4 py-1.5"
        :style="isMyTurn
          ? { background: 'var(--cg-accent)', color: 'var(--cg-accent-contrast)' }
          : { color: 'var(--cg-text-muted)' }"
      >
        <template v-if="ab.phase === 'bidding'">{{ $t('game.bidding') }}</template>
        {{ isMyTurn ? $t('game.yourTurn') : $t('game.waitingFor', { name: activeName }) }}
      </span>
      <UButton
        v-if="ab.phase === 'bidding' && isMyTurn"
        size="sm"
        variant="outline"
        @click="passBid"
      >
        {{ $t('game.passBid') }}
      </UButton>
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
      @play="onPlay"
    />

    <!-- Your eaten pile -->
    <button
      v-if="viewerSeat !== null && eaten(viewerSeat).length"
      type="button"
      data-tour="taken"
      class="w-full cg-surface rounded-xl px-3 py-2 flex items-center justify-between text-sm"
      :title="`View the ${eaten(viewerSeat).length} cards you've eaten`"
      @click="showEaten = viewerSeat"
    >
      <span class="flex items-center gap-1.5">
        <UIcon name="i-lucide-utensils" /> Your eaten cards
      </span>
      <span class="flex -space-x-4">
        <PlayingCard
          v-for="(c, i) in eaten(viewerSeat).slice(0, 6)"
          :key="i"
          :card="c"
          :width="28"
        />
        <span v-if="eaten(viewerSeat).length > 6" class="text-xs self-center ms-5" :style="{ color: 'var(--cg-text-muted)' }">
          +{{ eaten(viewerSeat).length - 6 }}
        </span>
      </span>
    </button>

    <MoveLogSlideover :entries="log.entries.value" />

    <!-- Eaten-cards viewer -->
    <UModal v-model:open="eatenModalOpen" :title="`${players.find((p) => p.seat === showEaten)?.name ?? ''} — eaten cards`" :ui="modalUi">
      <template #body>
        <div v-if="showEaten !== null" class="flex flex-wrap gap-1.5 justify-center">
          <PlayingCard v-for="(c, i) in eaten(showEaten)" :key="i" :card="c" :width="52" />
          <p v-if="!eaten(showEaten).length" class="text-sm" :style="{ color: 'var(--cg-text-muted)' }">
            No cards eaten yet.
          </p>
        </div>
      </template>
    </UModal>

    <!-- End-of-game dialog: natural result (scoreboard) OR host-ended notice. -->
    <GameOverDialog
      v-if="scores || endedBy"
      v-model:open="showGameOver"
      :scores="scores"
      :ended-by="endedBy"
      :players="players"
      :viewer-seat="viewerSeat"
      game-id="albastini"
      :can-rematch="canRematch"
      @rematch="emit('restart')"
      @new-game="emit('newGame')"
      @exit="emit('exit')"
    />
  </div>
</template>
