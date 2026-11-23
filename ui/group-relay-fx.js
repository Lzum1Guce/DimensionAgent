/**
 * DimensionAgent 0.5.2 Star-Rail Group Avatar Stage & Relay Arc Animation Engine
 * Supports 4 handoff scenes across Work Group & Chat Group:
 *  1. Lead -> Members concurrent fan-out (`#D97757` Claude coral-amber)
 *  2. Member A -> Member B dependency relay (`#D97706` warm gold)
 *  3. Members -> Lead completion convergence (`#248A59` emerald)
 *  4. Chat Group 1-hop speaker-to-speaker banter hop (`#D97757`)
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function ensureRelaySvg(stageEl) {
  if (!stageEl) return null;
  let svg = stageEl.querySelector(':scope > svg.group-relay-svg');
  if (!svg) {
    svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'group-relay-svg');
    svg.setAttribute('aria-hidden', 'true');
    stageEl.prepend(svg);
  }
  return svg;
}

export function triggerSeatLandPulse(seatEl) {
  if (!seatEl) return;
  seatEl.classList.remove('is-relay-landed');
  void seatEl.offsetWidth;
  seatEl.classList.add('is-relay-landed');
  setTimeout(() => seatEl.classList.remove('is-relay-landed'), 480);
}

export function shootRelayArc(stageEl, fromEl, toEl, {
  color = 'var(--color-accent, #D97757)',
  delayMs = 0,
  onLand = null,
} = {}) {
  if (!stageEl || !fromEl || !toEl || fromEl === toEl) return;
  if (reducedMotion()) {
    if (onLand) setTimeout(onLand, delayMs);
    return;
  }

  setTimeout(() => {
    if (!stageEl.isConnected || !fromEl.isConnected || !toEl.isConnected) return;
    const svg = ensureRelaySvg(stageEl);
    if (!svg || svg.childElementCount > 24) return;

    const stageRect = stageEl.getBoundingClientRect();
    const fromRing = fromEl.querySelector('.grok-seat-avatar, .star-seat-ring') || fromEl;
    const toRing = toEl.querySelector('.grok-seat-avatar, .star-seat-ring') || toEl;
    const r1 = fromRing.getBoundingClientRect();
    const r2 = toRing.getBoundingClientRect();
    if (r1.width === 0 || r2.width === 0) return;

    const x1 = r1.left - stageRect.left + r1.width / 2;
    const y1 = r1.top - stageRect.top + 6;
    const x2 = r2.left - stageRect.left + r2.width / 2;
    const y2 = r2.top - stageRect.top + 6;
    const dx = Math.abs(x2 - x1);
    if (dx < 6) return;

    const lift = Math.min(28, Math.max(14, dx * 0.2));
    const mx = (x1 + x2) / 2;
    const my = Math.min(y1, y2) - lift;
    const d = `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;

    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('class', 'group-relay-arc');

    const orb = document.createElementNS(SVG_NS, 'circle');
    orb.setAttribute('r', '3.6');
    orb.setAttribute('fill', color);
    orb.setAttribute('class', 'group-relay-orb');

    const motion = document.createElementNS(SVG_NS, 'animateMotion');
    motion.setAttribute('dur', '0.44s');
    motion.setAttribute('fill', 'freeze');
    motion.setAttribute('keyPoints', '0;1');
    motion.setAttribute('keyTimes', '0;1');
    motion.setAttribute('calcMode', 'spline');
    motion.setAttribute('keySplines', '0.22 1 0.36 1');
    motion.setAttribute('path', d);
    orb.appendChild(motion);

    svg.appendChild(path);
    svg.appendChild(orb);
    if (typeof motion.beginElement === 'function') {
      try { motion.beginElement(); } catch {}
    }

    setTimeout(() => {
      orb.remove();
      triggerSeatLandPulse(toEl);
      onLand?.();
    }, 430);
    setTimeout(() => {
      path.remove();
    }, 580);
  }, Math.max(0, delayMs));
}
