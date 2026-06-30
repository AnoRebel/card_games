/**
 * Anime.js (v4) helpers for gamey, tactile event animations.
 *
 * Two gates:
 *   - prefers-reduced-motion → all helpers no-op (snap to final state).
 *   - motion preference 'subtle' → only quick/essential feedback runs; the
 *     flashier sequences (celebrate confetti-ish pop, slide-to-winner, tilt)
 *     are skipped or shortened.
 *
 * @vueuse/motion handles declarative component transitions; this is the
 * imperative, sequenced layer (deal, flip, slide, celebrate, press).
 */
import { animate, stagger, utils, createTimeline } from 'animejs'

function reduced(): boolean {
  return (
    import.meta.client &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  )
}

/** Read the persisted motion preference without a composable. */
function rich(): boolean {
  if (reduced()) return false
  if (!import.meta.client) return true
  try {
    return (localStorage.getItem('cg:motion') ?? '"rich"').includes('rich')
  } catch {
    return true
  }
}

/** Staggered, springy deal-in for a freshly rendered hand/row. */
export function dealIn(targets: string | Element | Element[]) {
  if (reduced()) return
  animate(targets, {
    translateY: [-36, 0],
    rotate: rich() ? [-8, 0] : 0,
    opacity: [0, 1],
    scale: [0.85, 1],
    delay: stagger(rich() ? 60 : 30),
    duration: rich() ? 520 : 320,
    ease: 'out(3)',
  })
}

/** A card flipping/popping onto the table when played. */
export function playCard(target: string | Element) {
  if (reduced()) return
  if (rich()) {
    animate(target, {
      scale: [0.7, 1.08, 1],
      rotateY: [90, 0],
      opacity: [0, 1],
      duration: 420,
      ease: 'out(4)',
    })
  } else {
    animate(target, { scale: [0.9, 1], opacity: [0, 1], duration: 200 })
  }
}

/** Slide captured cards toward the winner, then settle (trick/pickup). */
export function sweepTo(
  targets: string | Element | Element[],
  dx = 0,
  dy = -28,
) {
  if (reduced()) return
  animate(targets, {
    translateX: rich() ? dx : 0,
    translateY: dy,
    opacity: [1, 0],
    scale: [1, 0.9],
    duration: rich() ? 460 : 280,
    delay: stagger(rich() ? 40 : 20),
    ease: 'inOut(3)',
  })
}

/** Suit-change flourish — spin + pulse on the indicator. */
export function suitFlourish(target: string | Element) {
  if (reduced() || !rich()) return
  animate(target, {
    rotate: [0, 360],
    scale: [1, 1.4, 1],
    duration: 560,
    ease: 'inOut(3)',
  })
}

/** Win celebration — buoyant pop + shimmer. */
export function celebrate(target: string | Element) {
  if (reduced()) return
  const tl = createTimeline()
  tl.add(target, {
    scale: [0.6, 1.1, 1],
    rotate: rich() ? [-4, 3, 0] : 0,
    opacity: [0, 1],
    duration: rich() ? 720 : 360,
    ease: 'out(4)',
  })
  return tl
}

/** Quick tactile press feedback on tap/click. */
export function press(target: string | Element) {
  if (reduced()) return
  animate(target, {
    scale: [1, 0.94, 1],
    duration: 180,
    ease: 'out(2)',
  })
}

/**
 * Gentle continuous bob/float for a set of elements (e.g. footer suit pips).
 * Staggered so they ripple rather than move in lockstep. No-op when reduced.
 */
export function floatLoop(targets: string | Element | Element[]) {
  if (reduced()) return
  animate(targets, {
    translateY: [0, -5, 0],
    rotate: [0, 6, 0],
    duration: 2200,
    delay: stagger(160),
    loop: true,
    ease: 'inOut(2)',
  })
}

/** Subtle hover tilt for a card (rich only). */
export function tilt(target: Element, on: boolean) {
  if (reduced() || !rich()) return
  animate(target, {
    rotate: on ? -3 : 0,
    translateY: on ? -10 : 0,
    duration: 220,
    ease: 'out(2)',
  })
}

/**
 * FLIP-style "card flight": animate a floating clone of `from` flying to where
 * `to` sits, then resolve so the caller can commit the real state. Gives the
 * tactile sense of a card travelling hand → discard (or deck → hand). No-ops
 * (and resolves immediately) under reduced motion or when refs are missing.
 */
export function flyCard(
  from: Element | null | undefined,
  to: Element | null | undefined,
  opts: { scaleTo?: number } = {},
): Promise<void> {
  if (reduced() || !import.meta.client || !from || !to) return Promise.resolve()
  const a = from.getBoundingClientRect()
  const b = to.getBoundingClientRect()
  if (!a.width || !b.width) return Promise.resolve()

  const clone = from.cloneNode(true) as HTMLElement
  clone.style.cssText = `position:fixed;left:${a.left}px;top:${a.top}px;width:${a.width}px;height:${a.height}px;margin:0;pointer-events:none;z-index:9999;will-change:transform`
  document.body.appendChild(clone)

  const dx = b.left + (b.width - a.width) / 2 - a.left
  const dy = b.top + (b.height - a.height) / 2 - a.top

  // Scale toward the target. When `to` is a large container (e.g. a whole hand
  // row) matching its width would balloon the clone, so clamp to a sane range.
  // Callers that know the exact destination card size can pass `scaleTo`.
  const scaleEnd = opts.scaleTo ?? Math.min(1.25, Math.max(0.55, b.width / a.width))

  return new Promise<void>((resolve) => {
    animate(clone, {
      translateX: [0, dx],
      translateY: [0, dy],
      rotate: rich() ? [0, utils.random(-12, 12)] : 0,
      scale: [1, scaleEnd],
      duration: rich() ? 380 : 240,
      ease: 'inOut(3)',
      onComplete: () => {
        clone.remove()
        resolve()
      },
    })
  })
}

/**
 * Riffle/cut shuffle on a deck pile — a quick set of overshoot wiggles that read
 * as "the deck is being shuffled". Resolves when done so a deal can follow.
 */
export function shuffle(target: Element | null | undefined): Promise<void> {
  if (reduced() || !target) return Promise.resolve()
  const reps = rich() ? 3 : 1
  return new Promise<void>((resolve) => {
    const tl = createTimeline({ onComplete: () => resolve() })
    for (let i = 0; i < reps; i++) {
      tl.add(target, {
        translateX: [0, rich() ? 14 : 8, -10, 0],
        rotate: rich() ? [0, 5, -4, 0] : [0, 2, 0],
        scale: [1, 1.04, 1],
        duration: rich() ? 240 : 180,
        ease: 'inOut(2)',
      })
    }
  })
}

/** Theme-toggle cross-fade fallback. */
export function crossFade(target: string | Element, opacityTo = 1) {
  if (reduced()) {
    utils.set(target, { opacity: opacityTo })
    return
  }
  animate(target, { opacity: [0.4, opacityTo], duration: 300, ease: 'inOut(2)' })
}

/**
 * Full-screen confetti rain for a win. Spawns paper pieces above the viewport
 * that fall + tumble + drift, then clean themselves up. Mounted on <body> so it
 * overlays everything. Honors reduced/subtle motion (no-op).
 */
export function confetti(count = 90): void {
  if (reduced() || !rich() || !import.meta.client) return
  const colors = [
    'var(--cg-accent)',
    'oklch(0.82 0.18 30)',
    'oklch(0.85 0.17 140)',
    'oklch(0.82 0.16 250)',
    'oklch(0.88 0.18 90)',
    'oklch(0.7 0.2 330)',
  ]
  const layer = document.createElement('div')
  layer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:10000;overflow:hidden'
  document.body.appendChild(layer)

  const pieces: HTMLElement[] = []
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span')
    const w = utils.random(6, 12)
    p.style.cssText = `position:absolute;top:-5%;left:${utils.random(0, 100)}%;width:${w}px;height:${w * utils.random(0.4, 1)}px;background:${colors[i % colors.length]};border-radius:${utils.random(0, 3)}px;will-change:transform`
    layer.appendChild(p)
    pieces.push(p)
  }
  animate(pieces, {
    translateY: () => utils.random(window.innerHeight * 0.9, window.innerHeight * 1.2),
    translateX: () => utils.random(-120, 120),
    rotate: () => utils.random(-540, 540),
    opacity: [1, 1, 0],
    duration: () => utils.random(1600, 2800),
    delay: stagger(12),
    ease: 'out(2)',
    onComplete: () => layer.remove(),
  })
}

/** A dejected "you lost" reaction — a quick shake + dip on the table/result. */
export function loseShake(target: string | Element): void {
  if (reduced()) return
  animate(target, {
    translateX: rich() ? [0, -10, 9, -7, 5, 0] : [0, -5, 4, 0],
    translateY: [0, 4, 0],
    rotate: rich() ? [0, -1.5, 1.2, -0.6, 0] : 0,
    filter: rich()
      ? ['saturate(1)', 'saturate(0.6)', 'saturate(1)']
      : undefined,
    duration: rich() ? 620 : 360,
    ease: 'inOut(2)',
  })
}

/** Celebratory burst of small dots from a point (win moment, rich only). */
export function burst(container: HTMLElement) {
  if (reduced() || !rich()) return
  const colors = [
    'var(--cg-accent)',
    'oklch(0.8 0.16 30)',
    'oklch(0.82 0.16 140)',
    'oklch(0.8 0.16 250)',
  ]
  const dots: HTMLElement[] = []
  for (let i = 0; i < 18; i++) {
    const d = document.createElement('span')
    d.style.cssText = `position:absolute;left:50%;top:40%;width:8px;height:8px;border-radius:9999px;pointer-events:none;background:${colors[i % colors.length]}`
    container.appendChild(d)
    dots.push(d)
  }
  animate(dots, {
    translateX: () => utils.random(-160, 160),
    translateY: () => utils.random(-140, 60),
    scale: [1, 0],
    opacity: [1, 0],
    rotate: () => utils.random(-180, 180),
    duration: 900,
    ease: 'out(3)',
    onComplete: () => dots.forEach((d) => d.remove()),
  })
}
