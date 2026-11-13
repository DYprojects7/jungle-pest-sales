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
import { cents, dollars, localIsoDate } from './format';
import { useDebounced, useMediaQuery } from './hooks';
import type { ThemeChoice, UiState } from './state';
import { computePlan, exampleState, parseSaved, serialiseSaved } from './state';
import { applyTheme, goTo, readStored, writeStored } from './storage';
import { inputsSummary } from './text';

const JUMPS: { id: string; label: string }[] = [
  { id: 'ladder', label: 'Savings ladder' },
  { id: 'compare', label: 'Compare options' },
  { id: 'monthly', label: 'Monthly plan' },
  { id: 'simulator', label: 'Step by step' },
  { id: 'working', label: 'Tax working' },
  { id: 'before', label: 'Before you transfer' },
  { id: 'sources', label: 'Sources' },
];

export function App(): JSX.Element {
  // "Today" is the device's local date, read once when the page starts.
  const today = useMemo(() => localIsoDate(), []);
  const example = useMemo(() => exampleState(today), [today]);
  const saved = useMemo(() => parseSaved(readStored(), example), [example]);

  const [ui, setUi] = useState<UiState>(saved?.ui ?? example);
  const [theme, setTheme] = useState<ThemeChoice>(saved?.theme ?? 'system');
  const [inputsOpen, setInputsOpen] = useState(false);
  const wide = useMediaQuery('(min-width: 960px)');

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

  // Layout effects, so the theme is in place before the first paint and a reload never outruns a save.
  useLayoutEffect(() => applyTheme(theme), [theme]);
  useLayoutEffect(() => writeStored(serialiseSaved(ui, theme)), [ui, theme]);

  const update = (patch: Partial<UiState>): void => setUi((prev) => ({ ...prev, ...patch, isExample: false }));
  const reset = (): void => setUi(example);

  const spoken = useDebounced(result ? announcement(result) : '', 900);

  if (!result) {
    return (
      <div class="app">
        <Brand theme={theme} onTheme={setTheme} ya={null} projected={false} />
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
  const topNotices = result.warnings.filter((w) => w.severity === 'blocker' || w.code === 'PROJECTED_RULES');
  const showInputs = wide || inputsOpen;

  return (
    <div class="app">
      <aside class="panel" aria-label="Your numbers">
        <Brand theme={theme} onTheme={setTheme} ya={rules.ya} projected={rules.status === 'projected'} />

        <div class="panel-scroll">
          <div class="panel-head">
            <h2 class="panel-title">Your numbers</h2>
            <div class="panel-status">
              {ui.isExample ? (
                <span class="stamp" data-testid="example-flag">
                  Example: replace with your numbers
                </span>
              ) : (
                <span class="saved-note" data-testid="saved-flag">
                  Saved on this device
                </span>
              )}
              <button type="button" class="btn-link" id="reset" data-testid="reset" onClick={reset}>
                Reset to example
              </button>
            </div>
          </div>

          {!wide ? (
            <div class="summary-card">
              <ul class="summary-lines" data-testid="inputs-summary">
                {inputsSummary(ui, result.input.otherReliefs).map((line) => (
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
          ) : null}

          <div id="inputs" hidden={!showInputs}>
            <Inputs ui={ui} result={result} update={update} />
          </div>
        </div>

        <div class="readout" data-testid="sticky-bar">
          <button type="button" class="readout-main" onClick={() => goTo('recommendation')}>
            <span class="readout-line">
              Save <b data-testid="bar-saved">{cents(p.taxSaved)}</b>
              <span class="readout-sep" aria-hidden="true">
                {' · '}
              </span>
              <span class="sr-only">, </span>
              lock away <b data-testid="bar-locked">{dollars(p.totalContribution)}</b>
            </span>
            <span class="readout-go" aria-hidden="true">
              See the plan
            </span>
            <span class="sr-only">. Go to the plan.</span>
          </button>
          <p class="readout-fine">
            Estimate only · not tax advice · YA{rules.ya} · {daysLeftText(result)}
          </p>
        </div>
      </aside>

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
          <ul class="notices notices-top">
            {topNotices.map((w) => (
              <Notice key={w.code} warning={w} />
            ))}
          </ul>
        ) : null}

        <Recommendation
          result={result}
          ui={ui}
          today={today}
          onEveryDollar={() => update({ depth: 'every' })}
        />

        <nav class="jump" aria-label="Sections">
          {JUMPS.map((j) => (
            <button type="button" class="jump-link" key={j.id} onClick={() => goTo(j.id)}>
              {j.label}
            </button>
          ))}
        </nav>

        <Section
          id="ladder"
          title="Savings ladder"
          lede="Each block is a slice of extra contribution. Its height is the tax saved per dollar, which is your marginal rate at that point, and its area is the tax saved. The rate steps down as your taxable income falls, so later dollars save less."
        >
          <Ladder result={result} />
        </Section>

        <Section
          id="compare"
          title="Compare options"
          lede="Ready-made choices on the same numbers. They ignore your cash limit and minimum saving, so you can see what each scheme does at its limit."
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
          lede="Your tax computation now, and with the plan. Lines the plan changes are in bold."
        >
          <TaxWorking result={result} />
        </Section>

        <Section id="before" title="Before you transfer">
          <BeforeYouTransfer result={result} />
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
          { value: 'system', label: 'Auto' },
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
        ]}
        onChange={props.onTheme}
      />
    </header>
  );
}
