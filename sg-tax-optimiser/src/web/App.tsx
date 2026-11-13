import type { JSX } from 'preact';
import { useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { PlannerResult } from '../engine/types';
import { Inputs } from './components/Inputs';
import { Ladder } from './components/Ladder';
import { Recommendation, announcement } from './components/Recommendation';
import {
  BeforeYouTransfer,
  Compare,
  MonthlyPlanView,
  Notice,
  Section,
  Simulator,
  Sources,
  TaxWorking,
  daysLeftText,
} from './components/Sections';
import { SegmentedField } from './components/Controls';
import { cents, dollars } from './format';
import { useDebounced, useMediaQuery, useOnScreen, useToday } from './hooks';
import type { ThemeChoice, UiState } from './state';
import {
  applyEdit,
  computePlan,
  exampleLeft,
  exampleState,
  followCalendar,
  openIncomeYear,
  parseSaved,
  serialiseSaved,
  whatIf,
} from './state';
import { applyTheme, goTo, readStored, writeStored } from './storage';
import { deadlinePassed, exampleLeftText, inputsSummary } from './text';

/** Section links under the plan. The simulator's link carries its own heading, which names the step. */
const JUMPS: { id: string; label: string }[] = [
  { id: 'ladder', label: 'Savings ladder' },
  { id: 'compare', label: 'Compare options' },
  { id: 'monthly', label: 'Monthly plan' },
  { id: 'simulator', label: '' },
  { id: 'working', label: 'Tax working' },
  { id: 'before', label: 'Before you transfer' },
  { id: 'sources', label: 'Sources' },
];

/** Roughly the height of the phone's bottom bar: a headline figure hidden under it does not count as on screen. */
const BAR_COVERS = 72;

export function App(): JSX.Element {
  // "Today" is the device's local date. It is kept current while the page stays open, so a tab left open
  // through the end of December counts the days down and then says the deadline has passed.
  const today = useToday();
  const example = useMemo(() => exampleState(today), [today]);
  // Read once, when the page starts.
  const [saved] = useState(() => parseSaved(readStored(), example));

  // Only somebody's own numbers are restored. The untouched example always opens for today's date.
  const [ui, setUi] = useState<UiState>(saved?.ui ?? example);
  // The numbers that Reset replaced, kept for this visit so the reset can be undone.
  const [undo, setUndo] = useState<UiState | null>(null);
  const [theme, setTheme] = useState<ThemeChoice>(saved?.theme ?? 'system');
  const [inputsOpen, setInputsOpen] = useState(false);
  const [kept, setKept] = useState(true);
  const wide = useMediaQuery('(min-width: 960px)');
  const heroRef = useRef<HTMLParagraphElement>(null);
  const heroSeen = useOnScreen(heroRef, BAR_COVERS);

  // When the date moves on, the untouched example moves with it (in January it is the example for the new
  // year). Somebody's own numbers stay as they are, and the engine is told the new date.
  const exampleShown = useRef(example);
  useLayoutEffect(() => {
    const previous = exampleShown.current;
    if (previous === example) return;
    exampleShown.current = example;
    setUi((prev) => followCalendar(prev, example, previous));
  }, [example]);

  const lastGood = useRef<PlannerResult | null>(null);
  const computed = useMemo(() => {
    try {
      return { result: computePlan(ui, today), failed: false };
    } catch {
      return { result: lastGood.current, failed: true };
    }
  }, [ui, today]);
  if (computed.result && !computed.failed) lastGood.current = computed.result;
  const result = computed.result;
  const past = result ? deadlinePassed(result) : false;

  // What one change of setting would save, from the engine (lift the cash limit, switch on a scheme). Once the
  // deadline has passed there is nothing left to change for that year, so no change is suggested.
  const hint = useMemo(() => (result && !past ? whatIf(ui, today, result) : null), [ui, today, result, past]);

  // Layout effects, so the theme is in place before the first paint and a reload never outruns a save.
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => setKept(writeStored(serialiseSaved(ui, theme))), [ui, theme]);

  const update = (patch: Partial<UiState>): void => {
    setUndo(null);
    setUi((prev) => applyEdit(prev, patch));
  };
  // Reset and Undo each remove the control that was pressed, so focus moves to the one that takes its place.
  const focusNext = (id: string): void => {
    window.requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
  };
  const reset = (): void => {
    setUndo(ui.isExample ? null : ui);
    setUi(example);
    if (!ui.isExample) focusNext('undo-reset');
  };
  const undoReset = (): void => {
    if (undo) setUi(undo);
    setUndo(null);
    focusNext('reset');
  };

  const spoken = useDebounced(result ? announcement(result, hint) : '', 900);

  if (!result) {
    return (
      <div class="app">
        <div class="rail">
          <Brand theme={theme} onTheme={setTheme} ya={null} projected={false} />
        </div>
        <main class="results">
          <p class="notice notice-blocker">
            Something went wrong working out this plan.{' '}
            <button type="button" class="btn-link" onClick={reset}>
              Reset to example
            </button>
          </p>
        </main>
      </div>
    );
  }

  const { rules, plan: p } = result;
  const projected = rules.status === 'projected';
  const nothing = p.totalContribution === 0;
  const left = exampleLeft(ui, example);
  const step = result.input.preferences.simulatorStep ?? ui.simulatorStep;
  const summaryLines = inputsSummary(ui, result.input.otherReliefs);
  const openYear = past ? openIncomeYear(today, rules.incomeYear) : null;
  const switchYear = (): void => {
    if (openYear !== null) update({ incomeYear: openYear });
  };
  // Shown above the plan: anything that stops it, a deadline days away, and rules that are not final.
  const topNotices = result.warnings.filter(
    (w) => w.severity === 'blocker' || w.code === 'DEADLINE_SOON' || w.code === 'PROJECTED_RULES',
  );
  const showInputs = wide || inputsOpen;
  // On a phone the bottom bar repeats the headline figure, so it steps back while that figure is on screen.
  const barCompact = !wide && heroSeen === true;
  return (
    <div class="app">
      <div class="rail">
        <Brand theme={theme} onTheme={setTheme} ya={rules.ya} projected={projected} />

        <aside class="panel" id="numbers" aria-label="Your numbers">
          <div class="panel-scroll">
            <div class="panel-head">
              <h2 class="panel-title" data-testid="panel-title">
                {ui.isExample && !wide ? 'Example numbers' : 'Your numbers'}
              </h2>
              {/* On a phone the card is headed "Example numbers" and the plan below carries the stamp. */}
              {ui.isExample && wide ? (
                <div class="panel-status">
                  <span class="stamp" data-testid="example-flag">
                    Example: replace with your numbers
                  </span>
                </div>
              ) : null}
              {!ui.isExample ? (
                <div class="panel-status">
                  <span class="saved-note" data-testid="saved-flag">
                    {kept ? 'Your numbers, saved on this device' : 'Your numbers. This browser will not save them.'}
                  </span>
                  <button type="button" class="btn-link" id="reset" data-testid="reset" onClick={reset}>
                    Reset to example
                  </button>
                </div>
              ) : null}
              {left.length > 0 ? (
                <p class="field-note" data-testid="example-left">
                  {exampleLeftText(left)}
                </p>
              ) : null}
              {undo ? (
                <div class="panel-status" role="status">
                  <span class="saved-note">Your numbers were replaced by the example.</span>
                  <button type="button" class="btn-link" id="undo-reset" data-testid="undo-reset" onClick={undoReset}>
                    Undo
                  </button>
                </div>
              ) : null}
            </div>

            {!wide ? (
              <div class="summary-card">
                <ul class="summary-lines" data-testid="inputs-summary">
                  {summaryLines.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  class="btn btn-primary"
                  id="toggle-inputs"
                  data-testid="toggle-inputs"
                  aria-expanded={inputsOpen}
                  aria-controls="inputs"
                  onClick={() => setInputsOpen((open) => !open)}
                >
                  {inputsOpen ? 'Hide the inputs' : ui.isExample ? 'Enter your numbers' : 'Edit your numbers'}
                </button>
              </div>
            ) : (
              // On paper the form is left out and these lines stand in for it.
              <ul class="summary-lines print-only">
                {summaryLines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}

            <div id="inputs" hidden={!showInputs}>
              <Inputs ui={ui} example={example} result={result} update={update} />
            </div>

            {!wide && inputsOpen ? (
              <div class="inputs-end">
                <button type="button" class="btn btn-primary" data-testid="inputs-see-plan" onClick={() => goTo('recommendation')}>
                  See the plan
                </button>
                <button
                  type="button"
                  class="btn"
                  data-testid="inputs-hide"
                  onClick={() => {
                    setInputsOpen(false);
                    // Once the long form has gone, bring the short card back into view.
                    window.requestAnimationFrame(() => goTo('numbers'));
                  }}
                >
                  Hide the inputs
                </button>
              </div>
            ) : null}
          </div>

          <div class={`readout${barCompact ? ' is-compact' : ''}`} data-testid="sticky-bar">
            <button type="button" class="readout-main" onClick={() => goTo('recommendation')}>
              <span class="readout-line">
                {past ? (
                  <>
                    Deadline passed
                    <span class="readout-sep" aria-hidden="true">
                      {' · '}
                    </span>
                    <span class="sr-only">, </span>
                    would have saved <b data-testid="bar-saved">{cents(p.taxSaved)}</b>
                  </>
                ) : nothing ? (
                  <b data-testid="bar-nothing">Nothing more to put in this year</b>
                ) : (
                  <>
                    Save <b data-testid="bar-saved">{cents(p.taxSaved)}</b>
                    <span class="readout-sep" aria-hidden="true">
                      {' · '}
                    </span>
                    <span class="sr-only">, </span>
                    lock away <b data-testid="bar-locked">{dollars(p.totalContribution)}</b>
                  </>
                )}
              </span>
              <span class="readout-go" aria-hidden="true">
                See the plan
              </span>
              <span class="sr-only">. Go to the plan.</span>
            </button>
            {/* Two groups, so a long line breaks between them and never strands a word. */}
            <p class="readout-fine" data-testid="bar-fine">
              <span>Estimate only · not tax advice</span>
              <span>
                YA{rules.ya}
                {projected ? ' (projected)' : ''} · {daysLeftText(result)}
              </span>
            </p>
          </div>
        </aside>
      </div>

      <main class="results" id="results">
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true" data-testid="live">
          {spoken}
        </p>

        {computed.failed ? (
          <p class="notice notice-blocker">
            Something went wrong with the last change, so the figures below are from before it.
          </p>
        ) : null}

        {topNotices.length > 0 ? (
          <ul class="notices notices-top" data-testid="top-notices">
            {topNotices.map((w) => (
              <Notice
                key={w.code}
                warning={w}
                action={
                  w.code === 'DEADLINE_PASSED' && openYear !== null
                    ? { label: `Plan for ${openYear} instead`, onClick: switchYear, testid: 'notice-switch-year' }
                    : undefined
                }
              />
            ))}
          </ul>
        ) : null}

        <Recommendation
          result={result}
          ui={ui}
          today={today}
          hint={hint}
          openYear={openYear}
          onEveryDollar={() => update({ depth: 'every' })}
          onYear={(incomeYear) => update({ incomeYear })}
          heroRef={heroRef}
        />

        <nav class="jump" aria-label="Sections">
          {JUMPS.map((j) => (
            <button type="button" class="jump-link" key={j.id} data-jump={j.id} onClick={() => goTo(j.id)}>
              {j.id === 'simulator' ? `Every extra ${dollars(step)}` : j.label}
            </button>
          ))}
        </nav>

        <Section
          id="ladder"
          title="Savings ladder"
          // The lead-in describes the chart, so it goes when there is no chart to describe.
          lede={
            result.ladder.some((t) => t.rate > 0)
              ? 'Each block is a slice of extra contribution. Its height is the tax saved per dollar, which is your marginal rate at that point, and its area is the tax saved. The rate steps down as your taxable income falls, so later dollars save less.'
              : undefined
          }
        >
          <Ladder result={result} />
        </Section>

        <Section
          id="compare"
          title="Compare options"
          lede="Ready-made choices on the same numbers. They ignore your cash limit and your minimum saving, and they use SRS and the CPF top-up to yourself even if you switched them off, so you can see what each scheme does at its limit. Wasted dollars are locked away without saving any tax."
        >
          <Compare result={result} />
        </Section>

        <Section id="monthly" title="Monthly plan">
          <MonthlyPlanView result={result} />
        </Section>

        <Simulator result={result} step={ui.simulatorStep} onStep={(simulatorStep) => update({ simulatorStep })} />

        <Section
          id="working"
          title="How your tax is worked out"
          lede="Your tax computation now, and with the plan. Figures the plan changes are shaded."
        >
          <TaxWorking result={result} />
        </Section>

        <Section id="before" title="Before you transfer">
          <BeforeYouTransfer result={result} hint={hint} />
        </Section>

        <Section id="sources" title="Sources and assumptions">
          <Sources result={result} />
        </Section>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Brand and theme
// ---------------------------------------------------------------------------

function Brand(props: {
  theme: ThemeChoice;
  onTheme: (theme: ThemeChoice) => void;
  ya: number | null;
  projected: boolean;
}): JSX.Element {
  return (
    <header class="brand">
      <div class="brand-name">
        <svg class="brand-mark" width="30" height="30" viewBox="0 0 30 30" aria-hidden="true">
          <rect x="1" y="3" width="8" height="24" style={{ fill: 'var(--accent)' }} />
          <rect x="11" y="11" width="8" height="16" style={{ fill: 'var(--accent)' }} />
          <rect x="21" y="19" width="8" height="8" style={{ fill: 'none', stroke: 'var(--ink)' }} stroke-width="1.5" />
        </svg>
        <div>
          <h1 class="brand-title">Singapore Tax Optimiser</h1>
          <p class="brand-sub">
            Year-end SRS and CPF planner
            {props.ya !== null ? (
              <>
                {' · '}
                <span data-testid="ya">YA{props.ya}</span>
                {props.projected ? ' (projected)' : ''}
              </>
            ) : null}
          </p>
        </div>
      </div>
      <SegmentedField<ThemeChoice>
        name="theme"
        legend="Colour theme"
        hideLegend
        small
        value={props.theme}
        options={[
          { value: 'system', label: 'System' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onChange={props.onTheme}
      />
    </header>
  );
}
