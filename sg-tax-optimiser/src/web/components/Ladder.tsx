import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import type { LadderTier, PlannerResult } from '../../engine/types';
import { cents, centsPerDollar, dollars, pct, plain } from '../format';
import { useElementWidth } from '../hooks';
import {
  flatLadderText,
  ladderEmptyText,
  ladderSummary,
  tierPlanUse,
  tierPlanUseInline,
  tierRange,
  zeroReasonText,
} from '../text';
import { TableScroll } from './Controls';

interface LadderProps {
  result: PlannerResult;
}

/** The savings ladder: the chart, its key, and the same figures as a table. */
export function Ladder({ result }: LadderProps): JSX.Element {
  const [active, setActive] = useState<number | null>(null);
  const tiers = result.ladder;

  if (tiers.length === 0) {
    return (
      <p class="empty" data-testid="ladder-empty">
        {ladderEmptyText(result)}
      </p>
    );
  }

  // With no tax to save anywhere there are no steps: an axis over an all-hatched plot would say nothing.
  if (tiers.every((t) => t.rate <= 0)) {
    return (
      <div class="ladder">
        <p class="empty" data-testid="ladder-flat">
          {flatLadderText(result)}
        </p>
        <LadderTable result={result} active={null} onActive={setActive} />
      </div>
    );
  }

  return (
    <div class="ladder">
      <LadderChart result={result} active={active} onActive={setActive} />
      <LadderKey result={result} />
      <LadderTable result={result} active={active} onActive={setActive} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

/** A step of 1, 2 or 5 times a power of ten that gives at most `maxTicks` intervals up to `max`. */
function niceStep(max: number, maxTicks: number): number {
  if (!(max > 0)) return 1;
  const rough = max / Math.max(1, maxTicks);
  const power = 10 ** Math.floor(Math.log10(rough));
  for (const base of [1, 2, 5, 10]) {
    if (base * power >= rough) return base * power;
  }
  return 10 * power;
}

/** Rough rendered width of a label, to decide whether it fits before drawing it. `perChar` is in ems. */
function textWidth(text: string, fontSize = 12, perChar = 0.56): number {
  return text.length * fontSize * perChar;
}

interface ChartProps extends LadderProps {
  active: number | null;
  onActive: (index: number | null) => void;
}

function LadderChart({ result, active, onActive }: ChartProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null);
  // Mouse: hovering shows a block's figures. Keyboard: focus shows them. Touch: a tap shows them, and a tap on
  // the block that is already showing puts them away. A tap also moves focus, and the order of the focus, blur
  // and click events around it is not something to rely on, so the tap is judged by what was showing when the
  // finger went down.
  const lastPointer = useRef<string>('mouse');
  const shownAtPress = useRef<number | null>(null);
  const activeNow = useRef<number | null>(active);
  activeNow.current = active;
  const measured = useElementWidth(boxRef, 640);
  const tiers = result.ladder;
  const planTotal = result.plan.totalContribution;

  // Drawn at 1 unit = 1 CSS pixel, so labels keep their size on a phone.
  const W = Math.max(288, Math.floor(measured));
  const compact = W < 520;
  // A lone tier is one flat block; it does not need the height a staircase does.
  const H = tiers.length === 1 ? (compact ? 200 : 216) : compact ? 240 : 280;
  const m = { top: 30, right: 12, bottom: 42, left: 42 };
  const plotW = W - m.left - m.right;
  const plotH = H - m.top - m.bottom;
  const base = m.top + plotH;

  // One x scale: additional contribution in dollars.
  const xMax = Math.max(1, tiers[tiers.length - 1]?.toContribution ?? 1);
  const x = (v: number): number => m.left + (Math.min(Math.max(v, 0), xMax) / xMax) * plotW;
  const xStep = niceStep(xMax, compact ? 3 : 5);
  const xTicks: number[] = [];
  for (let v = 0; v <= xMax + 1e-6; v += xStep) xTicks.push(v);
  const lastTick = xTicks[xTicks.length - 1] ?? 0;
  const endGap = x(xMax) - x(lastTick);
  const showEnd = endGap >= textWidth(plain(lastTick)) / 2 + textWidth(plain(xMax)) + 10;

  // One y scale: tax saved per dollar, in percent, with headroom above the tallest block.
  const maxPct = Math.max(0, ...tiers.map((t) => t.rate * 100));
  const yTop = maxPct > 0 ? maxPct * 1.12 : 2;
  const yStep = niceStep(yTop, 4);
  const yMax = Math.ceil(yTop / yStep - 1e-9) * yStep;
  const y = (ratePct: number): number => base - (ratePct / yMax) * plotH;
  const yTicks: number[] = [];
  for (let v = 0; v <= yMax + 1e-9; v += yStep) yTicks.push(Math.round(v * 100) / 100);

  // The plan marker's label goes on the side with room for it, in the longest wording that fits.
  const flagX = x(planTotal);
  const flagPrefersLeft = flagX > m.left + plotW * 0.55;
  let flag: { text: string; x: number; anchor: 'start' | 'end' } | null = null;
  for (const text of [`Your plan: ${dollars(planTotal)}`, `Plan: ${dollars(planTotal)}`, 'Plan']) {
    const w = textWidth(text, 12, 0.6);
    const fitsLeft = flagX - 7 - w >= 2;
    const fitsRight = flagX + 7 + w <= W - 2;
    if (!fitsLeft && !fitsRight) continue;
    const left = fitsLeft && (flagPrefersLeft || !fitsRight);
    flag = { text, x: left ? flagX - 7 : flagX + 7, anchor: left ? 'end' : 'start' };
    break;
  }
  const tip = active !== null ? tiers[active] : undefined;

  return (
    <figure class="chart">
      <figcaption class="chart-caption">
        <span class="chart-axis-title">Tax saved per dollar (%)</span>
      </figcaption>
      <div class="chart-scroll">
        <div class="chart-box" ref={boxRef}>
          <svg
            class="chart-svg"
            width={W}
            height={H}
            viewBox={`0 0 ${W} ${H}`}
            role="group"
            aria-label={ladderSummary(result)}
          >
            <defs>
              <pattern
                id="ladder-hatch-free"
                width="7"
                height="7"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(45)"
              >
                <rect width="7" height="7" style={{ fill: 'var(--chart-zone)' }} />
                <rect width="2" height="7" style={{ fill: 'var(--chart-hatch)' }} />
              </pattern>
              <pattern
                id="ladder-hatch-cap"
                width="7"
                height="7"
                patternUnits="userSpaceOnUse"
                patternTransform="rotate(-45)"
              >
                <rect width="7" height="7" style={{ fill: 'var(--chart-zone)' }} />
                <rect width="2" height="7" style={{ fill: 'var(--chart-hatch)' }} />
              </pattern>
            </defs>

            {/* y grid and labels */}
            {yTicks.map((v) => (
              <g key={`y${v}`}>
                <line
                  x1={m.left}
                  x2={W - m.right}
                  y1={y(v)}
                  y2={y(v)}
                  fill="none"
                  style={{ stroke: v === 0 ? 'var(--rule-strong)' : 'var(--rule)' }}
                  stroke-width="1"
                />
                <text class="chart-tick" x={m.left - 8} y={y(v) + 4} text-anchor="end" style={{ fill: 'var(--ink-3)' }}>
                  {`${v}%`}
                </text>
              </g>
            ))}

            {/* tiers */}
            {tiers.map((t, i) => {
              const x0 = x(t.fromContribution) + (i > 0 ? 1 : 0);
              const x1 = x(t.toContribution) - (i < tiers.length - 1 ? 1 : 0);
              if (t.rate <= 0) return <ZeroZone key={i} tier={t} x0={x0} x1={x1} top={m.top} base={base} />;
              const top = y(t.rate * 100);
              const split = x(t.fromContribution + t.usedByPlan);
              const hasUsed = t.usedByPlan > 0;
              const hasOpen = t.usedByPlan < t.amount;
              const usedX1 = hasOpen ? split - 1 : x1;
              const openX0 = hasUsed ? split + 1 : x0;
              const whole = !(hasUsed && hasOpen);
              return (
                <g key={i}>
                  {hasUsed && usedX1 - x0 >= 1 ? (
                    <rect x={x0} y={top} width={usedX1 - x0} height={base - top} style={{ fill: 'var(--accent)' }} />
                  ) : null}
                  {hasOpen && x1 - openX0 >= 2 ? (
                    <rect
                      x={openX0 + 0.75}
                      y={top + 0.75}
                      width={Math.max(0.5, x1 - openX0 - 1.5)}
                      height={Math.max(0.5, base - top - 0.75)}
                      style={{ fill: 'var(--chart-open)', stroke: 'var(--ink-2)' }}
                      stroke-width="1.5"
                    />
                  ) : null}
                  {hasUsed ? (
                    <BlockLabel
                      tier={t}
                      x0={x0}
                      x1={usedX1}
                      top={top}
                      base={base}
                      onFill
                      withSaving={whole}
                    />
                  ) : null}
                  {hasOpen ? (
                    <BlockLabel tier={t} x0={openX0} x1={x1} top={top} base={base} onFill={false} withSaving={whole} />
                  ) : null}
                </g>
              );
            })}

            {/* where the plan stops */}
            {planTotal > 0 ? (
              <g>
                <line
                  x1={flagX}
                  x2={flagX}
                  y1={m.top - 12}
                  y2={base}
                  fill="none"
                  style={{ stroke: 'var(--ink)' }}
                  stroke-width="1.5"
                />
                {flag ? (
                  <text
                    class="chart-flag"
                    x={flag.x}
                    y={m.top - 13}
                    text-anchor={flag.anchor}
                    style={{ fill: 'var(--ink)' }}
                  >
                    {flag.text}
                  </text>
                ) : null}
              </g>
            ) : null}

            {/* x axis */}
            {xTicks.map((v) => {
              // A label centred on a tick at the right-hand edge would run off the drawing: end it at the tick.
              const runsOff = x(v) + textWidth(plain(v), 12, 0.62) / 2 > W - 1;
              return (
                <g key={`x${v}`}>
                  <line
                    x1={x(v)}
                    x2={x(v)}
                    y1={base}
                    y2={base + 5}
                    fill="none"
                    style={{ stroke: 'var(--rule-strong)' }}
                    stroke-width="1"
                  />
                  <text
                    class="chart-tick"
                    x={x(v)}
                    y={base + 18}
                    text-anchor={v === 0 ? 'start' : runsOff ? 'end' : 'middle'}
                    style={{ fill: 'var(--ink-3)' }}
                  >
                    {plain(v)}
                  </text>
                </g>
              );
            })}
            {showEnd ? (
              <text class="chart-tick" x={x(xMax)} y={base + 18} text-anchor="end" style={{ fill: 'var(--ink-3)' }}>
                {plain(xMax)}
              </text>
            ) : null}
            <text
              class="chart-axis-title"
              x={m.left + plotW / 2}
              y={H - 5}
              text-anchor="middle"
              style={{ fill: 'var(--ink-2)' }}
            >
              Extra contribution (S$)
            </text>

            {/* highlight and hit areas, on top */}
            {tiers.map((t, i) => {
              const x0 = x(t.fromContribution);
              const x1 = x(t.toContribution);
              const top = t.rate > 0 ? y(t.rate * 100) : m.top;
              const hitW = Math.max(14, x1 - x0);
              const hitX = Math.min(Math.max(m.left, (x0 + x1) / 2 - hitW / 2), W - m.right - hitW);
              return (
                <g key={`hit${i}`}>
                  {active === i ? (
                    <rect
                      x={x0 + 1}
                      y={top - 1}
                      width={Math.max(1, x1 - x0 - 2)}
                      height={base - top + 1}
                      fill="none"
                      style={{ stroke: 'var(--ink)' }}
                      stroke-width="2"
                      pointer-events="none"
                    />
                  ) : null}
                  <rect
                    class="chart-hit"
                    x={hitX}
                    y={m.top}
                    width={hitW}
                    height={plotH}
                    fill="transparent"
                    tabIndex={0}
                    role="img"
                    aria-label={tierSentence(t, result)}
                    onPointerDown={(e) => {
                      lastPointer.current = e.pointerType;
                      shownAtPress.current = activeNow.current;
                    }}
                    onPointerEnter={(e) => {
                      if (e.pointerType === 'mouse') onActive(i);
                    }}
                    onPointerLeave={(e) => {
                      if (e.pointerType === 'mouse') onActive(null);
                    }}
                    onClick={() => {
                      const putAway = lastPointer.current !== 'mouse' && shownAtPress.current === i;
                      shownAtPress.current = null;
                      onActive(putAway ? null : i);
                    }}
                    onFocus={() => onActive(i)}
                    onBlur={() => onActive(null)}
                  />
                </g>
              );
            })}
          </svg>

          {tip && active !== null ? (
            <ChartTip
              tier={tip}
              result={result}
              cx={(x(tip.fromContribution) + x(tip.toContribution)) / 2}
              top={tip.rate > 0 ? y(tip.rate * 100) : base - plotH * 0.45}
              width={W}
            />
          ) : null}
        </div>
      </div>
    </figure>
  );
}

function tierSentence(t: LadderTier, result: PlannerResult): string {
  if (t.rate <= 0) return `${tierRange(t)}: no tax saved, ${zeroReasonText(t, result.rules)}.`;
  return (
    `${tierRange(t)}: saves ${centsPerDollar(t.rate)} per dollar, ${cents(t.taxSaved)} in total. ` +
    `In your plan: ${tierPlanUseInline(t)}.`
  );
}

/** A zero-saving stretch: a hatched zone the full height of the plot, so it cannot be read as a small rate. */
function ZeroZone(props: { tier: LadderTier; x0: number; x1: number; top: number; base: number }): JSX.Element | null {
  const { tier, x0, x1, top, base } = props;
  const w = x1 - x0;
  if (w < 1) return null;
  const pattern = tier.zeroReason === 'reliefCap' ? 'ladder-hatch-cap' : 'ladder-hatch-free';
  const label = 'No tax saved';
  const labelW = textWidth(label) + 14;
  return (
    <g>
      <rect x={x0} y={top} width={w} height={base - top} style={{ fill: `url(#${pattern})` }} />
      {w >= labelW + 12 ? (
        <g>
          <rect x={x0 + 6} y={top + 8} width={labelW} height="22" rx="3" style={{ fill: 'var(--chart-open)' }} />
          <text class="chart-label" x={x0 + 13} y={top + 23} style={{ fill: 'var(--ink)' }}>
            {label}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** The rate (and, where there is room, the tax saved) written inside a block. Drawn only when it fits. */
function BlockLabel(props: {
  tier: LadderTier;
  x0: number;
  x1: number;
  top: number;
  base: number;
  onFill: boolean;
  withSaving: boolean;
}): JSX.Element | null {
  const { tier, x0, x1, top, base, onFill, withSaving } = props;
  const w = x1 - x0;
  const h = base - top;
  const rate = pct(tier.rate);
  const saving = `saves ${cents(tier.taxSaved)}`;
  const ink = onFill ? 'var(--accent-ink)' : 'var(--ink)';
  if (w < textWidth(rate, 13) + 16) return null;
  if (h < 24) {
    // Too shallow to write in: put the rate just above the block.
    return (
      <text class="chart-label" x={x0 + 2} y={top - 6} style={{ fill: 'var(--ink)' }}>
        {rate}
      </text>
    );
  }
  return (
    <g>
      <text class="chart-label chart-label-strong" x={x0 + 9} y={top + 19} style={{ fill: ink }}>
        {rate}
      </text>
      {withSaving && h >= 44 && w >= textWidth(saving) + 20 ? (
        <text class="chart-label" x={x0 + 9} y={top + 36} style={{ fill: ink }}>
          {saving}
        </text>
      ) : null}
    </g>
  );
}

function ChartTip(props: { tier: LadderTier; result: PlannerResult; cx: number; top: number; width: number }): JSX.Element {
  const { tier, result, cx, top, width } = props;
  const half = Math.min(118, width / 2 - 4);
  const left = Math.min(Math.max(cx, half + 4), width - half - 4);
  const above = top >= 96;
  return (
    <div
      class={`chart-tip${above ? ' chart-tip-above' : ''}`}
      style={{ left: `${left}px`, top: `${above ? top - 10 : top + 10}px`, maxWidth: `${half * 2}px` }}
      aria-hidden="true"
    >
      <strong>{tier.rate > 0 ? `${cents(tier.taxSaved)} saved` : 'No tax saved'}</strong>
      <span>{tierRange(tier)}</span>
      <span>
        {tier.rate > 0 ? `${centsPerDollar(tier.rate)} per dollar` : zeroReasonText(tier, result.rules)}
      </span>
      {tier.rate > 0 ? <span>In your plan: {tierPlanUseInline(tier)}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------

function LadderKey({ result }: LadderProps): JSX.Element {
  const tiers = result.ladder;
  const anyUsed = tiers.some((t) => t.usedByPlan > 0);
  const anyOpen = tiers.some((t) => t.rate > 0 && t.usedByPlan < t.amount);
  const free = tiers.find((t) => t.rate <= 0 && t.zeroReason !== 'reliefCap');
  const capped = tiers.find((t) => t.rate <= 0 && t.zeroReason === 'reliefCap');
  return (
    <ul class="key" aria-label="Chart key">
      {anyUsed ? (
        <li>
          <span class="key-swatch key-plan" aria-hidden="true" />
          In your plan
        </li>
      ) : null}
      {anyOpen ? (
        <li>
          <span class="key-swatch key-open" aria-hidden="true" />
          Saves tax, not in your plan
        </li>
      ) : null}
      {free ? (
        <li>
          <HatchSwatch pattern="ladder-hatch-free" />
          No tax saved: {zeroReasonText(free, result.rules)}
        </li>
      ) : null}
      {capped ? (
        <li>
          <HatchSwatch pattern="ladder-hatch-cap" />
          No tax saved: {zeroReasonText(capped, result.rules)}
        </li>
      ) : null}
    </ul>
  );
}

function HatchSwatch({ pattern }: { pattern: string }): JSX.Element {
  return (
    <svg class="key-swatch" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="2" style={{ fill: `url(#${pattern})` }} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

function LadderTable({ result, active, onActive }: ChartProps): JSX.Element {
  return (
    <TableScroll label="Savings ladder figures" stack="rows">
      <table class="table table-mid" data-testid="ladder-table" role="table">
        <caption class="sr-only">The savings ladder as figures, one row per tier</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Extra contribution
            </th>
            <th scope="col" role="columnheader" class="num">
              Amount
            </th>
            <th scope="col" role="columnheader" class="num">
              Tax saved per dollar
            </th>
            <th scope="col" role="columnheader" class="num">
              Tax saved
            </th>
            <th scope="col" role="columnheader" class="num">
              Running total
            </th>
            <th scope="col" role="columnheader">
              In your plan
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {result.ladder.map((t, i) => (
            <tr
              key={i}
              role="row"
              class={active === i ? 'is-active' : undefined}
              onMouseEnter={() => onActive(i)}
              onMouseLeave={() => onActive(null)}
            >
              <th scope="row" role="rowheader">
                <span class="fig nowrap">{tierRange(t)}</span>
                {t.rate > 0 ? null : (
                  <span class="cell-note" data-testid="tier-zero-reason">
                    No tax saved: {zeroReasonText(t, result.rules)}
                  </span>
                )}
              </th>
              <td role="cell" class="num" data-label="Amount">
                {dollars(t.amount)}
              </td>
              <td role="cell" class="num" data-label="Tax saved per dollar">
                {t.rate > 0 ? pct(t.rate) : <span class="tag tag-neg">0%</span>}
              </td>
              <td role="cell" class="num" data-label="Tax saved">
                {cents(t.taxSaved)}
              </td>
              <td role="cell" class="num" data-label="Running total">
                {cents(t.cumulativeTaxSaved)}
              </td>
              <td role="cell" class="fig nowrap" data-label="In your plan">
                {tierPlanUse(t)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableScroll>
  );
}
