/**
 * In-game event notifications — toasts driven by engine state deltas.
 *
 * Watches a game session's state and surfaces meaningful events (turn start,
 * pickup, suit change, skip, last-card call, trick won, round/match end) as
 * Nuxt UI toasts. Gated by the notifications preference; reduced-motion is
 * respected by Nuxt UI's toast animations.
 */
import type { BaseGameState, BaseMove, Seat } from '@card-games/engine-core'
import type { GameTransport } from '~/transports/types'

interface LastCardish extends BaseGameState {
  activeSuit?: string
  pendingPickup?: number
  declaredLastCard?: Seat | null
  awaitingCall?: Seat | null
  hands?: Record<Seat, unknown[]>
  roundWinner?: Seat | null
}

export function useGameNotifications(
  transportRef: Ref<GameTransport | null>,
  gameId: MaybeRefOrGetter<string>,
) {
  // Resolve composables in setup context (they use inject()).
  const { notifications } = usePreferences()
  const toast = useToast()
  const { $t } = useI18n()

  let prevSuit: string | undefined
  let prevPickup = 0
  let prevDeclared: Seat | null | undefined
  let prevAwaiting: Seat | null | undefined
  let prevOnLast = false
  let wasMyTurn = false
  let notifiedTerminal = false
  let off: (() => void) | null = null
  let offPresence: (() => void) | null = null

  // Shared themed toast. Livelier (accent ring + bold title), readable duration.
  const notify = (
    title: string,
    icon: string,
    opts: { accent?: boolean; duration?: number } = {},
  ) =>
    toast.add({
      title,
      icon,
      duration: opts.duration ?? 4500,
      ui: {
        root: 'bg-[var(--cg-surface-solid)] ring-2 ring-[var(--cg-accent)]/40 text-[var(--cg-text)] shadow-lg',
        title: 'text-[var(--cg-text)] font-semibold',
        icon: opts.accent ? 'text-[var(--cg-accent)] size-6' : 'text-[var(--cg-text-muted)] size-5',
        progress: 'bg-[var(--cg-accent)]',
      },
    })
  const notifyTop = (title: string, icon: string) =>
    notify(title, icon, { accent: true })

  function bind(transport: GameTransport<BaseGameState, BaseMove>) {
    const gid = toValue(gameId)

    // Join/leave notifications (online rooms). Diff the presence roster.
    const withPresence = transport as GameTransport<BaseGameState, BaseMove> & {
      onPresence?: (cb: () => void) => () => void
    }
    // Track only CONNECTED members: a disconnected player is kept in the roster
    // (for grace-period reconnect) with connected:false, so we must treat the
    // connected→disconnected transition as "left", not just roster removal.
    const connectedNames = () => {
      const map = new Map<string, string>()
      for (const p of transport.getPresence()) {
        if (p.connected) map.set(p.playerId, p.name)
      }
      return map
    }
    let known = connectedNames()
    offPresence =
      withPresence.onPresence?.(() => {
        if (!notifications.value) return
        const current = connectedNames()
        for (const [id, name] of current) {
          if (!known.has(id)) {
            const sp = transport.getPresence().find((p) => p.playerId === id)?.spectator
            notifyTop(`${name} joined${sp ? ' (spectator)' : ''}`, 'i-lucide-user-plus')
          }
        }
        for (const [id, name] of known) {
          if (!current.has(id)) {
            notifyTop(`${name} left`, 'i-lucide-user-minus')
          }
        }
        known = current
      }) ?? null

  off = transport.onChange((view) => {
    if (!notifications.value) return
    const s = view.state as LastCardish
    const players = transport.getPlayers()
    const nameOf = (seat: Seat | null | undefined) =>
      players.find((p) => p.seat === seat)?.name ?? '—'

    // Your turn (rising edge).
    if (view.isMyTurn && !wasMyTurn) {
      notify($t('game.yourTurn'), 'i-lucide-hand', { accent: true, duration: 3000 })
    }
    wasMyTurn = view.isMyTurn

    if (gid === 'last-card') {
      // Suit change (wild played).
      if (prevSuit !== undefined && s.activeSuit && s.activeSuit !== prevSuit) {
        const sym = { c: '♣', s: '♠', h: '♥', d: '♦' }[s.activeSuit] ?? s.activeSuit
        notify(`${$t('game.suit')}: ${sym}`, 'i-lucide-shuffle', { accent: true })
      }
      prevSuit = s.activeSuit

      // Pickup pending grew.
      if ((s.pendingPickup ?? 0) > prevPickup && (s.pendingPickup ?? 0) > 0) {
        notify($t('game.pickup', { n: s.pendingPickup }), 'i-lucide-plus', { accent: true })
      }
      prevPickup = s.pendingPickup ?? 0

      // Last Card declared (called correctly).
      if (s.declaredLastCard != null && s.declaredLastCard !== prevDeclared) {
        notify(
          $t('game.lastCardCalled', { name: nameOf(s.declaredLastCard) }),
          'i-lucide-alert-triangle',
          { accent: true, duration: 4500 },
        )
      }
      prevDeclared = s.declaredLastCard

      // Someone reduced to their last card but hasn't declared yet (at risk).
      if (s.awaitingCall != null && s.awaitingCall !== prevAwaiting) {
        notify(
          $t('game.lastCardHolding', { name: nameOf(s.awaitingCall) }),
          'i-lucide-flame',
          { accent: true, duration: 4500 },
        )
      }
      prevAwaiting = s.awaitingCall

      // YOU are on your last card (only the viewer's hand is visible). Fire once
      // per descent to one — covers single, and the moment after a pair leaves
      // you with one. Cleared when you're no longer at one.
      const myCount = view.viewerSeat != null ? (s.hands?.[view.viewerSeat]?.length ?? -1) : -1
      const onLast = myCount === 1
      if (onLast && !prevOnLast) {
        notify($t('game.youOnLastCard'), 'i-lucide-flame', { accent: true, duration: 5000 })
      }
      prevOnLast = onLast
    }

    // Game over.
    if (view.scores && !notifiedTerminal) {
      notifiedTerminal = true
      const winner = players.find((p) => view.scores!.winners.includes(p.seat))
      notify($t('game.wins', { name: winner?.name ?? '—' }), 'i-lucide-trophy', {
        accent: true,
        duration: 6000,
      })
    }
    })
  }

  // Rebind whenever the live transport changes; reset per-game trackers.
  watch(
    transportRef,
    (t) => {
      off?.()
      offPresence?.()
      off = null
      offPresence = null
      prevSuit = undefined
      prevPickup = 0
      prevDeclared = undefined
      prevAwaiting = undefined
      prevOnLast = false
      wasMyTurn = false
      notifiedTerminal = false
      if (t) bind(t)
    },
    { immediate: true },
  )

  onScopeDispose(() => {
    off?.()
    offPresence?.()
  })
}
