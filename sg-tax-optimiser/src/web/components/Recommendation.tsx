import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PlannerResult } from '../../engine/types';
import { cents, centsPerDollar, countOf, dollars, shortDate } from '../format';
import type { UiState } from '../state';
import { computePlan } from '../state';
import { copyText } from '../storage';
import { LEVERS, LEVER_NAME, headline, planParts, stopReason, summaryText } from '../text';
import { Row } from './Controls';

const LEVER_TESTID = { srs: 'reco-srs', cpfSelf: 'reco-cpf-self', cpfFamily: 'reco-cpf-family' } as const;

interface RecommendationProps {
  result: PlannerResult;
  ui: UiState;
  today: string;
  /** Switch "How far down the ladder?" to Every tax dollar. */
  onEveryDollar: () => void;
}

/** The answer: what to put where, what it saves, what it locks away, and why it stops there. */
export function Recommendation({ result, ui, today, onEveryDollar }: RecommendationProps): JSX.Element {
  const { plan: p, rules, levers, monthlyPlan } = result;
  const parts = planParts(result);
  const nothing = p.totalContribution === 0;

  // When nothing is recommended, see whether going all the way down the ladder would find something.
  const everyDollar = useMemo(() => {
    if (!nothing || ui.depth === 'every') return null;
    try {
      const alt = computePlan({ ...ui, depth: 'every' }, today).plan;
      return alt.totalContribution > 0 ? alt : null;
    } catch {
      return null;
    }
  }, [nothing, ui, today]);

  const shownLevers = LEVERS.filter((l) => (levers[l].eligible && levers[l].enabled) || p.contributions[l] > 0);
  const paidShare = p.taxBefore > 0 ? Math.min(1, Math.max(0, p.taxAfter / p.taxBefore)) : 1;

  return (
    <section class="slab" id="recommendation" aria-labelledby="reco-title" tabIndex={-1}>
      <div class="slab-top">
        <p class="eyebrow">
          Your plan for YA{rules.ya}
          {rules.status === 'projected' ? ', projected rules' : ''}
        </p>
        {ui.isExample ? <span class="stamp stamp-slab">Example: replace with your numbers</span> : null}
      </div>

      <div class="slab-grid">
        <div class="slab-main">
          <p class="hero-label">Tax saved</p>
          <p class="hero-figure" data-testid="reco-tax-saved">
            {cents(p.taxSaved)}
          </p>
          {!nothing ? (
            <p class="hero-sub">
              <span data-testid="reco-rate">{centsPerDollar(p.savingRate)}</span> back for every dollar you lock away
            </p>
          ) : null}

          <h2 class="slab-headline" id="reco-title" data-testid="reco-headline">
            {nothing ? (
              'Nothing more to put in this year.'
            ) : (
              <>
                <span>
                  Put{' '}
                  {parts.map((part, i) => (
                    <i key={part.lever}>
                      {i > 0 ? (i === parts.length - 1 ? ' and ' : ', ') : ''}
                      <b>{dollars(part.amount)}</b> into {part.into}
                    </i>
                  ))}
                  .
                </span>{' '}
                <span>
                  You save <b>{cents(p.taxSaved)}</b> in tax.
                </span>
              </>
            )}
          </h2>

          <p class="slab-reason" data-testid="reco-reason">
            {stopReason(result)}
          </p>

          {everyDollar ? (
            <div class="slab-offer">
              <p>
                Going all the way down the ladder would save {cents(everyDollar.taxSaved)} by locking away{' '}
                {dollars(everyDollar.totalContribution)}: {centsPerDollar(everyDollar.savingRate)} back per dollar.
              </p>
              <button type="button" class="btn btn-slab" data-testid="offer-every" onClick={onEveryDollar}>
                Show the Every tax dollar view
              </button>
            </div>
          ) : null}
        </div>

        <div class="slip">
          <dl class="rows">
            {shownLevers.map((l) => (
              <Row key={l} label={LEVER_NAME[l]} value={dollars(p.contributions[l])} testid={LEVER_TESTID[l]} />
            ))}
            <Row total label="Cash you lock away" value={dollars(p.totalContribution)} testid="reco-locked" />
          </dl>
          <dl class="rows">
            <Row label="Tax before" value={cents(p.taxBefore)} testid="reco-tax-before" />
            <Row strong label="Tax after" value={cents(p.taxAfter)} testid="reco-tax-after" />
          </dl>
          {p.taxBefore > 0 ? (
            <div class="meter" aria-hidden="true">
              <span class="meter-paid" style={{ flexGrow: paidShare }} />
              <span class="meter-saved" style={{ flexGrow: 1 - paidShare }} />
            </div>
          ) : null}
          {p.taxBefore > 0 ? (
            <p class="meter-key" aria-hidden="true">
              <span>
                <i class="dot dot-paid" /> still to pay
              </span>
              <span>
                <i class="dot dot-saved" /> saved
              </span>
            </p>
          ) : null}
        </div>
      </div>

      <div class="slab-foot">
        <CopySummary result={result} isExample={ui.isExample} />
        <p class="slab-deadline">
          {monthlyPlan.daysToDeadline >= 0 ? (
            <>
              <b>{countOf(monthlyPlan.daysToDeadline, 'day')}</b> left to transfer, by{' '}
              {shortDate(monthlyPlan.deadline)}
            </>
          ) : (
            <>The {shortDate(monthlyPlan.deadline)} deadline has passed</>
          )}
        </p>
      </div>
    </section>
  );
}

/** Copy the plan as plain text. If the browser refuses, show the text selected so it can be copied by hand. */
function CopySummary({ result, isExample }: { result: PlannerResult; isExample: boolean }): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const text = summaryText(result, isExample);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (state === 'manual' && boxRef.current) {
      boxRef.current.focus();
      boxRef.current.select();
    }
  }, [state]);

  const onCopy = (): void => {
    // writeText is called synchronously inside this click handler.
    void copyText(text).then((ok) => {
      setState(ok ? 'copied' : 'manual');
      window.clearTimeout(timer.current);
      if (ok) timer.current = window.setTimeout(() => setState('idle'), 2500);
    });
  };

  return (
    <div class="copy">
      <button type="button" class="btn btn-slab" id="copy-summary" data-testid="copy-summary" onClick={onCopy}>
        {state === 'copied' ? 'Copied' : 'Copy summary'}
      </button>
      <span class="sr-only" role="status">
        {state === 'copied' ? 'Summary copied.' : ''}
      </span>
      {state === 'manual' ? (
        <div class="copy-manual">
          <label for="summary-text">Your browser blocked the copy. The summary is selected below: copy it from here.</label>
          <textarea id="summary-text" ref={boxRef} class="copy-box" readOnly rows={8} value={text} data-testid="summary-text" />
        </div>
      ) : null}
    </div>
  );
}

/** The plain sentence announced to screen readers when the plan changes. */
export function announcement(result: PlannerResult): string {
  return `${headline(result)} ${stopReason(result)}`;
}
