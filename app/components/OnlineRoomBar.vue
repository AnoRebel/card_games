<script setup lang="ts">
/**
 * Online room controls. Reads REACTIVE room metadata (host, visibility, phase,
 * spectator) from the session so the Start button + Public/Private badge update
 * correctly. Spectators see a read-only indicator and no share/host controls.
 */
import type { WsTransport, RoomInfo } from '~/transports/WsTransport'
import type { BaseGameState, BaseMove } from '@card-games/engine-core'

const props = defineProps<{
  transport: WsTransport<BaseGameState, BaseMove>
  shareUrl: string
  spectatorUrl: string
  passcode?: string | null
}>()

const session = useGameSession(props.transport)
const { copy } = useClipboard()
const copiedKey = ref<string | null>(null)

function copyAs(key: string, value: string) {
  copy(value)
  copiedKey.value = key
  setTimeout(() => {
    if (copiedKey.value === key) copiedKey.value = null
  }, 1500)
}

const info = computed(
  () => (session.roomInfo.value ?? null) as RoomInfo | null,
)
const isHost = computed(() => info.value?.isHost ?? false)
const amSpectator = computed(() => info.value?.amSpectator ?? false)
const isLocked = computed(() => info.value?.visibility === 'locked')
const phase = computed(() => info.value?.phase ?? 'lobby')
const seated = computed(() => info.value?.seated ?? 0)
const here = computed(() => info.value?.here ?? 0)
const minPlayers = computed(() => info.value?.minPlayers ?? 2)
const canStart = computed(
  () => isHost.value && phase.value === 'lobby' && seated.value >= minPlayers.value,
)

// Reconnect countdown: when a seated player drops mid-game the server sets a
// grace deadline; show a live countdown so everyone knows the game will end if
// they don't return. A 1s ticker drives the remaining seconds.
const now = ref(Date.now())
let ticker: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  ticker = setInterval(() => (now.value = Date.now()), 500)
})
onBeforeUnmount(() => {
  if (ticker) clearInterval(ticker)
})
const graceSeconds = computed(() => {
  const until = info.value?.disconnectGraceUntil ?? null
  if (!until) return null
  const s = Math.ceil((until - now.value) / 1000)
  return s > 0 ? s : 0
})
</script>

<template>
  <div class="space-y-2">
    <!-- Reconnect countdown (a seated player dropped mid-game) -->
    <UAlert
      v-if="graceSeconds !== null"
      color="warning"
      variant="subtle"
      icon="i-lucide-user-x"
      :title="$t('game.playerLeftTitle')"
      :description="$t('game.playerLeftCountdown', { count: graceSeconds })"
    />

    <div class="cg-surface rounded-xl p-2.5 flex flex-wrap items-center gap-2">
    <UBadge color="info" variant="subtle" icon="i-lucide-users">
      {{ $t('game.seated', { count: seated }) }} ·
      {{ $t('game.here', { count: here }) }}
    </UBadge>

    <!-- Spectator indicator (read-only) -->
    <UBadge v-if="amSpectator" color="neutral" variant="subtle" icon="i-lucide-eye">
      Spectating
    </UBadge>

    <UBadge
      :color="isLocked ? 'warning' : 'success'"
      variant="subtle"
      :icon="isLocked ? 'i-lucide-lock' : 'i-lucide-globe'"
    >
      {{ isLocked ? 'Private' : 'Public' }}
    </UBadge>

    <UPopover mode="hover">
      <UButton size="xs" variant="ghost" color="neutral" icon="i-lucide-info" aria-label="About room links" />
      <template #content>
        <div class="p-3 text-xs max-w-64 space-y-1.5" :style="{ color: 'var(--cg-text-muted)' }">
          <p><strong class="text-default">Player link</strong> — share to let people join and play.</p>
          <p><strong class="text-default">Spectator link</strong> — share to let people watch only.</p>
          <p v-if="isLocked">This room is <strong class="text-default">private</strong>: links include the passcode, so only people you share them with can enter.</p>
          <p v-else>This room is <strong class="text-default">public</strong>: anyone with a link can enter.</p>
        </div>
      </template>
    </UPopover>

    <!-- Share controls: PLAYERS only (spectators can't invite). -->
    <template v-if="!amSpectator">
      <UButton
        v-if="passcode"
        size="xs"
        variant="soft"
        color="warning"
        icon="i-lucide-key-round"
        title="Copy passcode"
        @click="copyAs('code', passcode)"
      >
        {{ copiedKey === 'code' ? $t('game.copied') : passcode }}
      </UButton>
      <UButton
        size="xs"
        variant="outline"
        icon="i-lucide-link"
        title="Copy the link players use to join"
        @click="copyAs('player', shareUrl)"
      >
        {{ copiedKey === 'player' ? $t('game.copied') : $t('game.playerLink') }}
      </UButton>
      <UButton
        v-if="spectatorUrl"
        size="xs"
        variant="outline"
        color="neutral"
        icon="i-lucide-eye"
        title="Copy the watch-only link"
        @click="copyAs('spectator', spectatorUrl)"
      >
        {{ copiedKey === 'spectator' ? $t('game.copied') : $t('game.spectatorLink') }}
      </UButton>
    </template>

    <span class="flex-1" />

    <!-- Host controls -->
    <template v-if="isHost">
      <UButton
        size="xs"
        color="primary"
        icon="i-lucide-play"
        :disabled="!canStart"
        :title="canStart ? 'Start the game' : `Need at least ${minPlayers} players`"
        @click="transport.startGame()"
      >
        {{ $t('common.start') }}
      </UButton>
      <UButton
        v-if="phase === 'in-progress'"
        size="xs"
        color="error"
        variant="soft"
        icon="i-lucide-square"
        title="End the game"
        @click="transport.endGame()"
      >
        {{ $t('common.end') }}
      </UButton>
    </template>
    <UBadge v-else color="neutral" variant="subtle">
      {{ phase === 'lobby' ? 'Waiting for host…' : phase }}
    </UBadge>
    </div>
  </div>
</template>
