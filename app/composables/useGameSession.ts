/**
 * useGameSession — binds a GameTransport to reactive Vue state for a game view.
 *
 * The view component reads `view`, `legalMoves`, `isMyTurn`, `scores`, chat and
 * presence reactively, and calls `play()` / `sendChat()`. Works identically for
 * local and online transports.
 */
import type { BaseGameState, BaseMove } from '@card-games/engine-core'
import type {
  ChatMessage,
  GameTransport,
  PresenceInfo,
  TransportView,
} from '~/transports/types'

export function useGameSession<
  S extends BaseGameState,
  M extends BaseMove,
>(transport: GameTransport<S, M>) {
  const view = shallowRef<TransportView<S, M>>(transport.getView())
  const chat = ref<ChatMessage[]>(transport.getChat())
  const presence = ref<PresenceInfo[]>(transport.getPresence())
  // viewerSeat and players are NOT static: for online transports the seat is
  // assigned asynchronously after the WS `joined`/`room` messages arrive (it's
  // null at setup time). Snapshotting them once left the table reading
  // hands[null] → "0 in hand". Keep them as refs refreshed on every update.
  const viewerSeat = ref<number | null>(transport.viewerSeat)
  const players = ref<ReturnType<GameTransport<S, M>['getPlayers']>>(
    transport.getPlayers(),
  )
  const sync = () => {
    viewerSeat.value = transport.viewerSeat
    players.value = transport.getPlayers()
    presence.value = transport.getPresence()
  }

  // Online room metadata (host/visibility/phase/counts), reactive.
  const withRoom = transport as GameTransport<S, M> & {
    getRoomInfo?: () => unknown
  }
  const roomInfo = ref<unknown>(withRoom.getRoomInfo?.() ?? null)

  const offChange = transport.onChange((v) => {
    view.value = v
    sync()
  })
  const offChat = transport.onChat((m) => {
    chat.value = [...m]
  })
  // Online transports also emit room/presence changes without a state change
  // (seating, host, joins) — refresh seat/players/presence then too.
  const withPresence = transport as GameTransport<S, M> & {
    onPresence?: (cb: () => void) => () => void
  }
  const offPresence = withPresence.onPresence?.(() => {
    sync()
    roomInfo.value = withRoom.getRoomInfo?.() ?? null
    // touch view so isHost-style computeds re-evaluate
    view.value = { ...transport.getView() }
  })

  onScopeDispose(() => {
    offChange()
    offChat()
    offPresence?.()
  })

  const ready = computed(() => view.value.ready)
  const isMyTurn = computed(() => view.value.isMyTurn)
  const state = computed(() => view.value.state)
  const legalMoves = computed(() => view.value.legalMoves)
  const scores = computed(() => view.value.scores)
  const isTerminal = computed(() => scores.value !== null)

  async function play(move: M) {
    return transport.submitMove(move)
  }

  async function sendChat(body: string) {
    return transport.sendChat(body)
  }

  return {
    view,
    state,
    legalMoves,
    ready,
    isMyTurn,
    scores,
    isTerminal,
    roomInfo,
    chat,
    presence,
    // Reactive (see above) — consumers must read .value.
    players,
    viewerSeat,
    play,
    sendChat,
  }
}
