import type { JSX, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PlannerResult } from '../../engine/types';
import { BUY_LABEL, BUY_URL } from '../build';
import { cents, centsPerDollar, countOf, dollars, shortDate } from '../format';
import { useFitText } from '../hooks';
import type { UiState, WhatIf } from '../state';
import { beyondRules } from '../state';
import { copyText } from '../storage';
import {
  COUNTS_NEXT_YEAR,
  LEVER_NAME,
  deadlinePassed,
  deeperOffer,
  headline,
  horizonLines,
  horizonNote,
  leftOutSentence,
  lookingBack,
  newToThis,
  nothingText,
  ownCpfLeftOut,
  planCautions,
  planParts,
  stopReason,
  summaryText,
} from '../text';
import type { ReasonOptions } from '../text';
import { Row } from './Controls';
import { Notice } from './Sections';

const LEVER_TESTID = { srs: 'reco-srs', cpfSelf: 'reco-cpf-self', cpfFamily: 'reco-cpf-family' } as const;

interface RecommendationProps {
  result: PlannerResult;
  ui: UiState;
  today: string;
  /** The engine's plan with one setting changed, when that change would save more (see `whatIf`). */
  hint: WhatIf | null;
  /** When nothing is recommended: the engine's result with no minimum saving, if it would put something in. */
  deeper: PlannerResult | null;
  /** How the reason is worded (the default minimum, the cost of going deeper for a foreigner). */
  options: ReasonOptions;
  /** The income year to offer when the one on screen has closed, or null. */
  openYear: number | null;
  /** Switch "How far down the ladder?" to Every tax dollar. */
  onEveryDollar: () => void;
  onYear: (incomeYear: number) => void;
  /** Open the inputs if they are folded away, and go to one of them. */
  onField: (id: string) => void;
  /** True on the two-column layout. */
  wide: boolean;
  /** The tax-saved figure, so the page can tell when it is on screen. */
  heroRef: RefObject<HTMLParagraphElement | null>;
}

/** The answer: what to put where, what it saves, what it locks away, and why it stops there. */
export function Recommendation(props: RecommendationProps): JSX.Element {
  const { result, ui, today, hint, deeper, options, openYear, onEveryDollar, onYear, onField, wide, heroRef } = props;
  const { plan: p, rules, levers, monthlyPlan } = result;
  const parts = planParts(result);
  const nothing = p.totalContribution === 0;
  const past = deadlinePassed(result);
  const figure = cents(p.taxSaved);
  useFitText(heroRef, figure);
  // From 55, with the top-up that can still earn relief not yet entered: the engine leaves their own CPF out.
  const leftOut = ownCpfLeftOut(result);
  const leftOutNote = leftOutSentence(result);
  const horizon = past ? [] : horizonLines(result);
  const horizonSmallPrint = past ? '' : horizonNote(result);
  const cautions = planCautions(result);

  // Schemes in the order the person chose under "Which first?".
  const shownLevers = result.input.preferences.priority.filter(
    (l) => (levers[l].eligible && levers[l].enabled) || p.contributions[l] > 0,
  );
  const paidShare = p.taxBefore > 0 ? Math.min(1, Math.max(0, p.taxAfter / p.taxBefore)) : 1;
  const deadline = shortDate(monthlyPlan.deadline);
  // Opened in a year this build has no rules for: there is no open year to offer, so say what is needed.
  const beyond = past && openYear === null ? beyondRules(today) : null;

  return (
    <div class="answer">
      <section class="slab" id="recommendation" aria-labelledby="reco-title" tabIndex={-1}>
        <div class="slab-top">
          <p class="eyebrow">
            {past ? `YA${rules.ya}, deadline passed` : `Your plan for YA${rules.ya}`}
            {rules.status === 'projected' ? ', projected rules' : ''}
          </p>
          {ui.isExample ? (
            <span class="stamp stamp-slab" data-testid="example-flag-plan">
              Example: replace with your numbers
            </span>
          ) : null}
        </div>

        <div class="slab-grid">
          <div class="slab-main">
            <p class="hero-label">{past ? 'Tax this would have saved' : 'Tax saved'}</p>
            <p class={`hero-figure${past ? ' is-past' : ''}`} ref={heroRef} data-testid="reco-tax-saved">
              {figure}
            </p>
            {!nothing ? (
              <p class="hero-sub">
                <span data-testid="reco-rate">{centsPerDollar(p.savingRate)}</span> back for every dollar{' '}
                {past ? 'it would have locked away' : 'you lock away'}
              </p>
            ) : null}

            <h2 class="slab-headline" id="reco-title" data-testid="reco-headline">
              {past ? (
                `The ${deadline} deadline has passed.`
              ) : nothing ? (
                `${nothingText(result)}.`
              ) : (
                <>
                  <span>
                    Put{' '}
                    {parts.map((part, i) => (
                      <i key={part.lever}>
                        {i > 0 ? (i === parts.length - 1 ? ' and ' : ', ') : ''}
                        <b>{dollars(part.amount)}</b> into {keepTogether(part.into)}
                      </i>
                    ))}
                    .
                  </span>{' '}
                  <span>
                    You save <b>{figure}</b> in tax.
                  </span>
                </>
              )}
            </h2>

            <p class="slab-reason" data-testid="reco-reason">
              {past ? `${lookingBack(result)} ${COUNTS_NEXT_YEAR}` : stopReason(result, hint, options)}
            </p>
            {leftOutNote ? (
              <p class="slab-reason" data-testid="reco-left-out">
                {leftOutNote}
              </p>
            ) : null}
            {beyond !== null ? (
              <p class="slab-reason" data-testid="reco-outdated">
                This copy of the calculator has rules up to income year {beyond.newest}. Planning for {beyond.year}{' '}
                needs a newer version.
              </p>
            ) : null}

            {past && openYear !== null ? (
              <div class="slab-offer">
                <button type="button" class="btn btn-slab" data-testid="reco-switch-year" onClick={() => onYear(openYear)}>
                  Plan for {openYear} instead
                </button>
              </div>
            ) : null}

            {deeper ? (
              <div class="slab-offer" data-testid="offer">
                <p>{deeperOffer(deeper)}</p>
                {/* A foreigner is told what those dollars cost on the way out before being shown the way in. */}
                {options.deeperCaveat ? (
                  <p class="slab-offer-caveat" data-testid="offer-caveat">
                    {options.deeperCaveat}
                  </p>
                ) : null}
                <button type="button" class="btn btn-slab" data-testid="offer-every" onClick={onEveryDollar}>
                  Show the Every tax dollar view
                </button>
              </div>
            ) : null}
          </div>

          <div class="slip">
            <dl class="rows">
              {shownLevers.map((l) => (
                <Row
                  key={l}
                  label={LEVER_NAME[l]}
                  // Not "S$0": nothing has been decided about their own CPF until the figure is entered.
                  value={l === 'cpfSelf' && leftOut ? 'Left out' : dollars(p.contributions[l])}
                  testid={LEVER_TESTID[l]}
                />
              ))}
              <Row
                total
                label={past ? 'Would have locked away' : 'Cash you lock away'}
                value={dollars(p.totalContribution)}
                testid="reco-locked"
              />
            </dl>
            {/* How long, straight under how much. */}
            {horizon.length > 0 ? (
              <div class="horizon">
                <ul data-testid="reco-horizon">
                  {horizon.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                {horizonSmallPrint ? <p data-testid="reco-horizon-note">{horizonSmallPrint}</p> : null}
              </div>
            ) : null}
            <dl class="rows">
              <Row label="Tax before" value={cents(p.taxBefore)} testid="reco-tax-before" />
              <Row
                strong
                label={past ? 'Tax with the plan' : 'Tax after'}
                value={cents(p.taxAfter)}
                testid="reco-tax-after"
              />
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
                  <i class="dot dot-paid" /> {past ? 'tax with the plan' : 'still to pay'}
                </span>
                <span>
                  <i class="dot dot-saved" /> {past ? 'would have saved' : 'saved'}
                </span>
              </p>
            ) : null}

            {/* The deadline and the copy button close the slip, so the column ends level with the sentence
                beside it on a wide card. */}
            <div class="slip-foot">
              <p class="slab-deadline" data-testid="reco-deadline">
                {past ? (
                  <>The {deadline} deadline has passed</>
                ) : monthlyPlan.daysToDeadline === 0 ? (
                  <>
                    <b>Today is the last day</b> to transfer
                  </>
                ) : (
                  <>
                    <b>{countOf(monthlyPlan.daysToDeadline, 'day')}</b> left to transfer, by {deadline}
                  </>
                )}
              </p>
              <CopySummary result={result} isExample={ui.isExample} hint={hint} options={options} />
            </div>
          </div>
        </div>
      </section>

      {/* What decides whether a recommended dollar earns relief sits with the answer, in the engine's words. */}
      {cautions.length > 0 ? (
        <div class="answer-checks">
          <h3 class="answer-title" id="plan-cautions-title">
            {past ? 'About this plan' : 'Before you act on this plan'}
          </h3>
          <ul class="notices notices-plan" data-testid="plan-cautions" aria-labelledby="plan-cautions-title">
            {cautions.map((w) => (
              <Notice
                key={w.code}
                warning={w}
                action={
                  w.code === 'CPF_SELF_ROOM_UNCONFIRMED'
                    ? { label: 'Enter the figure', onClick: () => onField('cpfSelfRoom'), testid: 'caution-enter-room' }
                    : undefined
                }
              />
            ))}
          </ul>
        </div>
      ) : null}

      <NewToThis result={result} wide={wide} />

      {BUY_URL ? (
        <p class="shop" data-testid="shop-link">
          <a href={BUY_URL} target="_blank" rel="noopener">
            {BUY_LABEL}
          </a>
        </p>
      ) : null}
    </div>
  );
}

/** "cash top-up" stays on one line in the headline: a line that ends "top-" reads as a mistake. */
function keepTogether(text: string): (string | JSX.Element)[] {
  const phrase = 'cash top-up';
  return text.split(phrase).flatMap((piece, i) =>
    i === 0
      ? [piece]
      : [
          <i class="keep" key={i}>
            {phrase}
          </i>,
          piece,
        ],
  );
}

/**
 * A few lines for someone who has never used either scheme. Open beside the plan on a wide screen; folded to
 * its heading on a phone, where the plan should not be pushed down.
 */
function NewToThis(props: { result: PlannerResult; wide: boolean }): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null);
  // Set once, when the page starts: after that the person opens and closes it as they like.
  useLayoutEffect(() => {
    if (ref.current) ref.current.open = props.wide;
  }, []);
  return (
    <details class="more newbie" ref={ref} data-testid="new-to-this">
      <summary>New to this?</summary>
      <ul class="newbie-lines">
        {newToThis(props.result).map((line) => (
          <li key={line.term}>
            <b class="term">{line.term}: </b>
            {line.text}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Copy the plan as plain text. If the browser refuses, show the text selected so it can be copied by hand. */
function CopySummary(props: {
  result: PlannerResult;
  isExample: boolean;
  hint: WhatIf | null;
  options: ReasonOptions;
}): JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const text = summaryText(props.result, props.isExample, props.hint, props.options);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  useEffect(() => {
    if (state === 'manual' && boxRef.current) {
      boxRef.current.focus();
      boxRef.current.select();
      boxRef.current.scrollTop = 0;
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
          <textarea id="summary-text" ref={boxRef} class="copy-box" readOnly rows={10} value={text} data-testid="summary-text" />
        </div>
      ) : null}
    </div>
  );
}

/** The plain sentence announced to screen readers when the plan changes. */
export function announcement(result: PlannerResult, hint: WhatIf | null, options: ReasonOptions = {}): string {
  if (deadlinePassed(result)) return `${headline(result)} ${COUNTS_NEXT_YEAR}`;
  const leftOut = leftOutSentence(result);
  const checks = planCautions(result).length;
  return (
    `${headline(result)} ${stopReason(result, hint, options)}` +
    (leftOut ? ` ${leftOut}` : '') +
    (checks > 0 ? ` ${checks === 1 ? 'One thing' : `${checks} things`} to check before you act, listed under the plan.` : '')
  );
}
