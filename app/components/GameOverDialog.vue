<script setup lang="ts">
/**
 * End-of-game modal. Two modes:
 *  - natural end (`scores` present): ranked scoreboard, winner highlighted.
 *  - host-ended (`endedBy` set, no scores): a short "ended the game" notice.
 * Both offer rematch / new game / exit. Rematch keeps the same room/setup; new
 * game returns to setup; exit leaves to the lobby.
 */
import type { Player, ScoreResult, Seat } from '@card-games/engine-core'

const props = defineProps<{
  scores: ScoreResult | null
  /** Host who manually ended the game (no natural result). */
  endedBy?: string | null
  players: Player[]
  viewerSeat: Seat | null
  gameId: string
  /** Online host can trigger a rematch for everyone; offline always can. */
  canRematch?: boolean
}>()
const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ rematch: []; newGame: []; exit: [] }>()

const modalUi = useThemedModalUi()

// Albastini ranks by victory points (higher better); Last Card by penalty
// (lower better). Use victoryBySeat when present, else raw score.
const useVp = computed(() => !!props.scores?.victoryBySeat)
const rows = computed(() => {
  const s = props.scores
  if (!s) return []
  return props.players
    .map((p) => ({
      seat: p.seat,
      name: p.name,
      score: (useVp.value ? s.victoryBySeat?.[p.seat] : undefined) ?? s.bySeat[p.seat] ?? 0,
      won: s.winners.includes(p.seat),
      you: p.seat === props.viewerSeat,
    }))
    .sort((a, b) => (useVp.value ? b.score - a.score : a.score - b.score))
})
const medal = (i: number) => ['🥇', '🥈', '🥉'][i] ?? `${i + 1}`
const youWon = computed(
  () => !!props.scores && props.viewerSeat != null && props.scores.winners.includes(props.viewerSeat),
)
const winnerNames = computed(() =>
  props.players
    .filter((p) => props.scores?.winners.includes(p.seat))
    .map((p) => p.name)
    .join(', '),
)
</script>

<template>
  <UModal v-model:open="open" :title="$t('game.gameOver')" :ui="modalUi">
    <template #body>
      <!-- Host-ended (no natural result) -->
      <div v-if="!scores" class="text-center space-y-2 py-2">
        <p class="text-4xl">🛑</p>
        <p class="font-display text-lg font-bold">
          {{ $t('game.endedByHost', { name: endedBy || $t('game.theHost') }) }}
        </p>
        <p class="text-sm" :style="{ color: 'var(--cg-text-muted)' }">
          {{ $t('game.endedByHostBody') }}
        </p>
      </div>

      <!-- Natural end: scoreboard -->
      <div v-else class="space-y-4">
        <!-- Headline -->
        <div class="text-center space-y-1">
          <p class="text-4xl">{{ youWon ? '🏆' : '🎴' }}</p>
          <p class="font-display text-lg font-bold">
            {{ youWon ? $t('game.youWin') : $t('game.wins', { name: winnerNames || '—' }) }}
          </p>
          <p class="text-xs" :style="{ color: 'var(--cg-text-muted)' }">
            {{ useVp ? $t('game.scoredVp') : $t('game.scoredPenalty') }}
          </p>
        </div>

        <!-- Scoreboard -->
        <ol class="space-y-1">
          <li
            v-for="(row, i) in rows"
            :key="row.seat"
            class="flex items-center gap-3 rounded-lg px-3 py-2"
            :style="{
              background: row.won ? 'color-mix(in oklch, var(--cg-accent) 16%, transparent)' : 'var(--cg-surface)',
              border: row.won ? '1px solid var(--cg-accent)' : '1px solid var(--cg-border)',
            }"
          >
            <span class="w-7 text-center text-lg">{{ medal(i) }}</span>
            <span class="flex-1 truncate font-medium">
              {{ row.name }}
              <span v-if="row.you" class="text-xs" :style="{ color: 'var(--cg-text-muted)' }">
                ({{ $t('game.you') }})
              </span>
            </span>
            <span class="text-lg font-bold tabular-nums" :style="{ color: row.won ? 'var(--cg-accent)' : 'var(--cg-text)' }">
              {{ row.score }}
            </span>
          </li>
        </ol>
      </div>
    </template>
    <template #footer>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-2 w-full">
        <UButton
          v-if="canRematch"
          color="primary"
          icon="i-lucide-rotate-ccw"
          class="justify-center"
          @click="emit('rematch')"
        >
          {{ $t('game.rematch') }}
        </UButton>
        <UButton variant="outline" color="neutral" icon="i-lucide-settings-2" class="justify-center" @click="emit('newGame')">
          {{ $t('game.newGame') }}
        </UButton>
        <UButton variant="ghost" color="error" icon="i-lucide-log-out" class="justify-center" @click="emit('exit')">
          {{ $t('game.exit') }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
