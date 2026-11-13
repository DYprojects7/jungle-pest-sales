import type { ComponentChildren, JSX } from 'preact';
import { DISCLAIMER } from '../../engine';
import type { LeverId, PlannerResult, PlannerWarning, Scenario, TaxComputation } from '../../engine/types';
import { bandRows } from '../bands';
import { BUY_LABEL, BUY_URL, VERSION } from '../build';
import { cents, centsFigure, centsPerDollar, countOf, dollars, longDate, monthLabel, pct } from '../format';
import { SIMULATOR_STEPS, simulatorSteps } from '../state';
import type { WhatIf } from '../state';
import {
  COUNTS_NEXT_YEAR,
  LEVERS,
  LEVER_NAME,
  PLAN_CAUTION_CODES,
  SCENARIO_NAME,
  affordabilityNote,
  approximations,
  cautionsFor,
  cpfOpen,
  deadlineLines,
  deadlinePassed,
  factsFor,
  fullYearSplit,
  notModelledFor,
  sourcesFor,
  stopReason,
} from '../text';
import type { ReasonOptions } from '../text';
import { Row, SelectField, TableScroll } from './Controls';

interface SectionProps {
  result: PlannerResult;
}

/** A results section: a ruled heading, an optional lead-in, then content. */
export function Section(props: {
  id: string;
  title: string;
  lede?: ComponentChildren;
  children: ComponentChildren;
}): JSX.Element {
  return (
    <section class="section" id={props.id} aria-labelledby={`${props.id}-title`} tabIndex={-1}>
      <h2 class="section-title" id={`${props.id}-title`}>
        {props.title}
      </h2>
      {props.lede ? <p class="lede">{props.lede}</p> : null}
      {props.children}
    </section>
  );
}

/** Schemes worth a column: the ones this person can use. */
function usableLevers(result: PlannerResult): LeverId[] {
  return LEVERS.filter((l) => result.levers[l].eligible);
}

// ---------------------------------------------------------------------------
// Compare options
// ---------------------------------------------------------------------------

function sameSplit(a: Scenario, b: Scenario): boolean {
  return LEVERS.every((l) => a.contributions[l] === b.contributions[l]);
}

/**
 * The scenarios worth a row: "Do nothing more", the plan, and each ready-made option that puts money somewhere
 * and is not a copy of an option already listed. A foreigner cannot use CPF top-ups, so for them "SRS and CPF
 * top-up to self" and "Everything to the limit" are both "SRS only" under another name, and are left out.
 */
function compareRows(result: PlannerResult): Scenario[] {
  const kept: Scenario[] = [];
  for (const s of result.scenarios) {
    if (s.id === 'none' || s.id === 'recommended') kept.push(s);
    else if (s.totalContribution > 0 && !kept.some((k) => k.id !== 'recommended' && sameSplit(k, s))) kept.push(s);
  }
  return kept;
}

export function Compare({ result }: SectionProps): JSX.Element {
  const recommended = result.scenarios.find((s) => s.id === 'recommended');
  const rows = compareRows(result);
  const levers = usableLevers(result).filter((l) => rows.some((s) => s.contributions[l] > 0));
  const past = deadlinePassed(result);
  return (
    <TableScroll label="Options compared" stack="rows">
      <table class="table table-wide table-compare" data-testid="scenario-table" role="table">
        <caption class="sr-only">Ready-made options on the same numbers, compared with your plan</caption>
        <thead role="rowgroup">
          <tr role="row">
            <th scope="col" role="columnheader">
              Option
            </th>
            {levers.map((l) => (
              <th scope="col" role="columnheader" class="num" key={l}>
                {LEVER_NAME[l]}
              </th>
            ))}
            <th scope="col" role="columnheader" class="num">
              Cash locked away
            </th>
            <th scope="col" role="columnheader" class="num">
              Tax
            </th>
            <th scope="col" role="columnheader" class="num">
              Tax saved
            </th>
            <th scope="col" role="columnheader" class="num">
              Saved per dollar (cents)
            </th>
            <th scope="col" role="columnheader" class="num">
              Wasted dollars
            </th>
          </tr>
        </thead>
        <tbody role="rowgroup">
          {rows.map((s) => {
            const isPlan = s.id === 'recommended';
            const twin = !isPlan && s.id !== 'none' && recommended !== undefined && sameSplit(s, recommended);
            return (
              <tr key={s.id} role="row" class={isPlan ? 'is-plan' : undefined} data-scenario={s.id}>
                <th scope="row" role="rowheader">
                  {SCENARIO_NAME[s.id]}
                  {isPlan && !past ? (
                    <span class="cell-note">
                      <span class="tag tag-plan">Recommended</span>
                    </span>
                  ) : null}
                  {twin ? <span class="cell-note">Same as your plan</span> : null}
                </th>
                {levers.map((l) => (
                  <td
                    role="cell"
                    class="num c-lever"
                    key={l}
                    data-label={LEVER_NAME[l]}
                    data-zero={s.contributions[l] > 0 ? undefined : 'true'}
                  >
                    {dollars(s.contributions[l])}
                  </td>
                ))}
                <td role="cell" class="num c-cash" data-label="Cash locked away">
                  {dollars(s.totalContribution)}
                </td>
                <td role="cell" class="num c-tax" data-label="Tax">
                  {cents(s.taxPayable)}
                </td>
                <td role="cell" class="num c-saved" data-label="Tax saved" data-testid={isPlan ? 'plan-row-saved' : undefined}>
                  {cents(s.taxSaved)}
                </td>
                <td role="cell" class="num c-rate" data-label="Saved per dollar (cents)" data-testid={isPlan ? 'plan-row-rate' : undefined}>
                  {s.totalContribution > 0 ? centsFigure(s.savingRate) : 'n/a'}
                </td>
                <td role="cell" class="num c-wasted" data-label="Wasted dollars">
                  {s.wastedContribution > 0 ? (
                    <span class="tag tag-neg">{dollars(s.wastedContribution)}</span>
                  ) : (
                    'None'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

// ---------------------------------------------------------------------------
// Monthly plan
// ---------------------------------------------------------------------------

export function MonthlyPlanView(props: SectionProps & { onField: (id: string) => void }): JSX.Element {
  const { result, onField } = props;
  const { monthlyPlan: mp, plan: p, rules } = result;
  const levers = LEVERS.filter((l) => p.contributions[l] > 0);
  const passed = mp.daysToDeadline < 0;
  const stretch = affordabilityNote(result);
  // Cut-offs only for the schemes the plan uses, and only while there is still something to transfer.
  const cutOffs = passed ? [] : deadlineLines(result);
  return (
    <div class="monthly">
      <div class="countdown" data-testid="countdown">
        {passed ? (
          <>
            <span class="countdown-figure">0</span>
            <span class="countdown-text">
              days left. The deadline was {longDate(mp.deadline)}. {COUNTS_NEXT_YEAR}
            </span>
          </>
        ) : (
          <>
            <span class="countdown-figure" data-testid="days-left">
              {mp.daysToDeadline}
            </span>
            <span class="countdown-text">
              {mp.daysToDeadline === 0
                ? `days left. Today, ${longDate(mp.deadline)}, is the last day a contribution counts for YA${rules.ya}.`
                : `${mp.daysToDeadline === 1 ? 'day' : 'days'} until ${longDate(mp.deadline)}, the last day a contribution counts for YA${rules.ya}`}
            </span>
          </>
        )}
      </div>

      {mp.schedule.length > 0 ? (
        <TableScroll label="Monthly set-aside schedule" stack="lines">
          <table class="table table-fit" data-testid="monthly-table" role="table">
            <caption class="sr-only">How much to set aside each month until the deadline</caption>
            <thead role="rowgroup">
              <tr role="row">
                <th scope="col" role="columnheader">
                  Month
                </th>
                {levers.map((l) => (
                  <th scope="col" role="columnheader" class="num" key={l}>
                    {LEVER_NAME[l]}
                  </th>
                ))}
                <th scope="col" role="columnheader" class="num">
                  Set aside
                </th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {mp.schedule.map((row) => (
                <tr key={row.month} role="row">
                  <th scope="row" role="rowheader" class="nowrap">
                    {monthLabel(row.month)}
                  </th>
                  {levers.map((l) => (
                    <td role="cell" class="num c-lever" key={l} data-label={LEVER_NAME[l]}>
                      {dollars(row.amounts[l])}
                    </td>
                  ))}
                  <td role="cell" class="num c-total" data-label="Set aside">
                    {dollars(row.total)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot role="rowgroup">
              <tr class="is-total" role="row">
                <th scope="row" role="rowheader">
                  Total
                </th>
                {levers.map((l) => (
                  <td role="cell" class="num c-lever" key={l} data-label={LEVER_NAME[l]}>
                    {dollars(p.contributions[l])}
                  </td>
                ))}
                <td role="cell" class="num c-total" data-label="Set aside">
                  {dollars(p.totalContribution)}
                </td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      ) : (
        <p class="empty">
          {passed ? 'There is nothing left to schedule for this income year.' : 'Nothing to set aside: the plan is S$0.'}
        </p>
      )}

      {stretch ? (
        <div class="notice notice-caution monthly-stretch" data-testid="monthly-affordability">
          <span class="tag tag-caution">Check</span>
          <div class="notice-body">
            <p>
              {stretch.text} If that is more than you can spare, tell the plan how much cash you have and it will
              stay within it.
            </p>
            <button type="button" class="btn btn-small" data-testid="monthly-cash-limit" onClick={() => onField('cashLimit')}>
              Set a cash limit
            </button>
          </div>
        </div>
      ) : null}

      {p.totalContribution > 0 ? (
        <p class="prose" data-testid="full-year">
          Start in January next time and the same plan is <b>{dollars(mp.fullYearMonthly.total)} a month</b> over
          twelve months{levers.length > 1 ? `: ${fullYearSplit(result)}` : ''}.
        </p>
      ) : null}

      {cutOffs.length > 0 ? (
        <ul class="plain-list" data-testid="monthly-deadlines">
          {cutOffs.map((line) => (
            <li key={line.term}>
              <b class="term">{line.term}: </b>
              {line.text}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Every extra S$1,000
// ---------------------------------------------------------------------------

export function Simulator(props: SectionProps & { step: number; onStep: (step: number) => void }): JSX.Element {
  const { result, step, onStep } = props;
  // The engine's rows, plus one at the plan's own total when the step does not land on it.
  const rows = simulatorSteps(result);
  const levers = usableLevers(result).filter((l) => rows.some((r) => r.split[l] > 0));
  const used = result.input.preferences.simulatorStep ?? step;
  // Grouped under headings instead of a column that says "Yes" or "Beyond it" on every line.
  const groups = [
    { id: 'start', title: 'Where you are now', rows: rows.filter((r) => r.contribution === 0) },
    { id: 'plan', title: 'In your plan', rows: rows.filter((r) => r.contribution > 0 && r.withinPlan) },
    { id: 'beyond', title: 'Beyond your plan', rows: rows.filter((r) => r.contribution > 0 && !r.withinPlan) },
  ].filter((g) => g.rows.length > 0);
  return (
    <details class="fold" id="simulator">
      <summary>
        <span class="fold-text">
          <h2 class="section-title" id="simulator-title">
            Every extra {dollars(used)}
          </h2>
          <span class="fold-hint">What each further step saves, up to every scheme's limit</span>
        </span>
      </summary>
      <div class="fold-body">
        <SelectField
          inline
          id="simulatorStep"
          label="Step"
          value={step}
          options={SIMULATOR_STEPS.map((s) => ({ value: s, label: dollars(s) }))}
          onChange={(v) => onStep(Number(v))}
        />
        {rows.length > 1 ? (
          <TableScroll label="Tax at each step of extra contribution">
            <table class="table table-wide" data-testid="simulator-table">
              <caption class="sr-only">Tax and tax saved for each step of extra contribution</caption>
              <thead>
                <tr>
                  <th scope="col">Extra contribution</th>
                  <th scope="col" class="num">
                    This step saves
                  </th>
                  <th scope="col" class="num">
                    Per dollar (cents)
                  </th>
                  <th scope="col" class="num">
                    Tax saved so far
                  </th>
                  <th scope="col" class="num">
                    Tax
                  </th>
                  {levers.map((l) => (
                    <th scope="col" class="num" key={l}>
                      {LEVER_NAME[l]}
                    </th>
                  ))}
                </tr>
              </thead>
              {groups.map((g) => (
                <tbody key={g.title} data-group={g.id}>
                  <tr class="group-row">
                    <th scope="rowgroup" colSpan={5 + levers.length}>
                      {/* The heading stays in view while the table is scrolled sideways. */}
                      <span class="group-label">{g.title}</span>
                    </th>
                  </tr>
                  {g.rows.map((r) => (
                    <tr
                      key={r.contribution}
                      class={g.id === 'plan' ? 'is-plan' : undefined}
                      data-step
                      data-plan-total={r.planTotal ? 'true' : undefined}
                    >
                      <th scope="row" class="nowrap">
                        {dollars(r.contribution)}
                        {r.planTotal ? <span class="cell-note">Your plan's total</span> : null}
                      </th>
                      <td class="num">{r.contribution === 0 ? 'n/a' : cents(r.stepSaving)}</td>
                      <td class="num">{r.contribution === 0 ? 'n/a' : centsFigure(r.stepRate)}</td>
                      <td class="num">{cents(r.taxSaved)}</td>
                      <td class="num">{cents(r.taxPayable)}</td>
                      {levers.map((l) => (
                        <td class="num" key={l}>
                          {dollars(r.split[l])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              ))}
            </table>
          </TableScroll>
        ) : (
          <p class="empty">No scheme has room left, so there are no further steps to show.</p>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// How your tax is worked out
// ---------------------------------------------------------------------------

interface WorkingRow {
  label: string;
  before: string;
  after: string;
  kind?: 'sub' | 'strong' | 'total' | 'grand' | 'lost' | 'saved';
}

function workingRow(
  label: string,
  pick: (t: TaxComputation) => number,
  result: PlannerResult,
  format: (n: number) => string = dollars,
  kind?: WorkingRow['kind'],
): WorkingRow {
  return { label, before: format(pick(result.baseline)), after: format(pick(result.optimised)), kind };
}

export function TaxWorking({ result }: SectionProps): JSX.Element {
  const { baseline: b, optimised: o, rules } = result;
  const either = (pick: (t: TaxComputation) => number): boolean => pick(b) > 0 || pick(o) > 0;
  const cap = dollars(rules.personalReliefCap);

  const income: WorkingRow[] = [workingRow('Employment income', (t) => t.employmentIncome, result)];
  if (either((t) => t.employmentExpenses)) {
    income.push(workingRow('Less: employment expenses', (t) => t.employmentExpenses, result, dollars, 'sub'));
  }
  if (either((t) => t.otherTaxableIncome)) {
    income.push(workingRow('Other taxable income', (t) => t.otherTaxableIncome, result));
  }
  income.push(workingRow('Total income', (t) => t.totalIncome, result, dollars, 'total'));
  if (either((t) => t.donationDeduction)) {
    income.push(
      workingRow(
        `Less: donations, deducted at ${pct(rules.donationDeductionMultiplier)}`,
        (t) => t.donationDeduction,
        result,
        dollars,
        'sub',
      ),
    );
  }
  income.push(workingRow('Assessable income', (t) => t.assessableIncome, result, dollars, 'total'));

  // A CPF line is shown to everyone it can apply to. Someone with no CPF (a foreigner on a work pass) is not
  // shown three lines of S$0 for reliefs that are not open to them.
  const reliefs: WorkingRow[] = [workingRow('Earned Income Relief', (t) => t.reliefs.earnedIncome, result)];
  if (result.cpf.source !== 'none' || either((t) => t.reliefs.cpf)) {
    reliefs.push(workingRow('CPF relief, compulsory employee share', (t) => t.reliefs.cpf, result));
  }
  reliefs.push(workingRow('SRS relief', (t) => t.reliefs.srs, result));
  if (result.levers.cpfSelf.eligible || either((t) => t.reliefs.cpfTopUpSelf)) {
    reliefs.push(workingRow('CPF cash top-up relief, self', (t) => t.reliefs.cpfTopUpSelf, result));
  }
  if (result.levers.cpfFamily.eligible || either((t) => t.reliefs.cpfTopUpFamily)) {
    reliefs.push(workingRow('CPF cash top-up relief, family', (t) => t.reliefs.cpfTopUpFamily, result));
  }
  reliefs.push(workingRow('Other reliefs', (t) => t.reliefs.other, result));
  reliefs.push(workingRow('Reliefs before the cap', (t) => t.reliefs.totalBeforeCap, result, dollars, 'total'));
  if (either((t) => t.reliefs.lostToCap)) {
    reliefs.push(workingRow(`Lost to the ${cap} cap`, (t) => t.reliefs.lostToCap, result, dollars, 'lost'));
  }
  reliefs.push(workingRow(`Reliefs allowed, capped at ${cap}`, (t) => t.reliefs.totalAllowed, result, dollars, 'total'));

  const tax: WorkingRow[] = [
    workingRow('Chargeable income', (t) => t.chargeableIncome, result, dollars, 'strong'),
    workingRow('Tax from the rate table', (t) => t.grossTax, result, cents),
  ];
  if (either((t) => t.pitRebate)) {
    tax.push(workingRow('Less: Personal Income Tax Rebate', (t) => t.pitRebate, result, cents, 'sub'));
  }
  tax.push(workingRow('Tax payable', (t) => t.taxPayable, result, cents, 'grand'));
  tax.push({ label: 'Tax saved by the plan', before: '', after: cents(result.plan.taxSaved), kind: 'saved' });
  // The engine's marginal rate is the rate on the last dollar of chargeable income: what one more dollar of
  // relief would save. At a bracket edge that differs from the rate on the next dollar earned.
  tax.push(workingRow('Tax saved by your next dollar of relief', (t) => t.marginalRate, result, (n) => pct(n)));
  tax.push(workingRow('Tax as a share of total income', (t) => t.effectiveRate, result, (n) => pct(n)));

  const groups: { title: string; rows: WorkingRow[] }[] = [
    { title: 'Income', rows: income },
    { title: 'Personal reliefs', rows: reliefs },
    { title: 'Tax', rows: tax },
  ];

  const bands = bandRows(rules, b.chargeableIncome, o.chargeableIncome);

  return (
    <div class="working">
      <TableScroll label="Tax computation before and after the plan">
        <table class="table table-working" data-testid="working-table">
          <caption class="sr-only">Your tax computation now and with the plan, line by line</caption>
          <thead>
            <tr>
              <th scope="col">Line</th>
              <th scope="col" class="num">
                Now
              </th>
              <th scope="col" class="num">
                With the plan
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.title}>
              <tr class="group-row">
                <th scope="rowgroup" colSpan={3}>
                  {g.title}
                </th>
              </tr>
              {g.rows.map((r) => (
                <tr key={r.label} class={r.kind ? `is-${r.kind}` : undefined}>
                  <th scope="row">{r.label}</th>
                  <td class="num">{r.before}</td>
                  <td class={`num${r.before !== r.after && r.before !== '' ? ' changed' : ''}`}>
                    {r.after}
                    {r.before !== r.after && r.before !== '' ? <span class="sr-only"> (changed by the plan)</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </TableScroll>

      <h3 class="sub-title">The rate table, band by band</h3>
      <TableScroll label="Tax by band before and after the plan" stack="rows">
        <table class="table table-wide table-bands" data-testid="band-table" role="table">
          <caption class="sr-only">How much of your chargeable income falls in each tax band, and the tax on it</caption>
          <thead role="rowgroup">
            <tr role="row">
              <th scope="col" role="columnheader">
                Chargeable income band
              </th>
              <th scope="col" role="columnheader" class="num">
                Rate
              </th>
              <th scope="col" role="columnheader" class="num">
                In band now
              </th>
              <th scope="col" role="columnheader" class="num">
                Tax now
              </th>
              <th scope="col" role="columnheader" class="num">
                In band with the plan
              </th>
              <th scope="col" role="columnheader" class="num">
                Tax with the plan
              </th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {bands.map((band) => {
              const incomeChanged = band.before.income !== band.after.income;
              const taxChanged = band.before.tax !== band.after.tax;
              return (
                <tr key={band.from} role="row">
                  <th scope="row" role="rowheader" class="nowrap">
                    {band.to === null
                      ? `Above ${dollars(band.from)}`
                      : band.from === 0
                        ? `First ${dollars(band.to)}`
                        : `${dollars(band.from)} to ${dollars(band.to)}`}
                  </th>
                  <td role="cell" class="num" data-label="Rate">
                    {pct(band.rate)}
                  </td>
                  <td role="cell" class="num" data-label="In band now">
                    {dollars(band.before.income)}
                  </td>
                  <td role="cell" class="num" data-label="Tax now">
                    {cents(band.before.tax)}
                  </td>
                  <td role="cell" class={`num${incomeChanged ? ' changed' : ''}`} data-label="In band with the plan">
                    {dollars(band.after.income)}
                    {incomeChanged ? <span class="sr-only"> (changed by the plan)</span> : null}
                  </td>
                  <td role="cell" class={`num${taxChanged ? ' changed' : ''}`} data-label="Tax with the plan">
                    {cents(band.after.tax)}
                    {taxChanged ? <span class="sr-only"> (changed by the plan)</span> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot role="rowgroup">
            <tr class="is-total" role="row">
              <th scope="row" role="rowheader">
                Tax from the rate table
              </th>
              <td role="cell" data-empty="true" />
              <td role="cell" class="num" data-label="Chargeable income now">
                {dollars(b.chargeableIncome)}
              </td>
              <td role="cell" class="num" data-label="Tax now">
                {cents(b.grossTax)}
              </td>
              <td role="cell" class="num" data-label="Chargeable income with the plan">
                {dollars(o.chargeableIncome)}
              </td>
              <td role="cell" class="num" data-label="Tax with the plan">
                {cents(o.grossTax)}
              </td>
            </tr>
          </tfoot>
        </table>
      </TableScroll>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Before you transfer
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: PlannerWarning['severity'][] = ['blocker', 'caution', 'info'];
const SEVERITY_TAG: Record<PlannerWarning['severity'], string> = { blocker: 'Stop', caution: 'Check', info: 'Note' };

/**
 * One engine warning. `message` replaces the engine's wording where the page has a more exact sentence, and
 * `action` adds a button that does something about it.
 */
export function Notice(props: {
  warning: PlannerWarning;
  message?: string;
  action?: { label: string; onClick: () => void; testid?: string };
}): JSX.Element {
  const { warning, message, action } = props;
  return (
    <li class={`notice notice-${warning.severity}`} data-code={warning.code}>
      <span class={`tag tag-${warning.severity}`}>{SEVERITY_TAG[warning.severity]}</span>
      <div class="notice-body">
        <p>{message ?? warning.message}</p>
        {action ? (
          <button type="button" class="btn btn-small" data-testid={action.testid} onClick={action.onClick}>
            {action.label}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Three engine warnings are worded by the page, not the engine.
 * - The two about what stops the plan: the card already says why the plan stops (`stopReason`), naming the
 *   scheme that would have to be switched on and quoting the engine's plan for exactly that change. The note
 *   in the list repeats that sentence, so the page gives one reason in one wording, not the card's and then
 *   the engine's more general one ("the schemes you left off").
 * - The one about the minimum saving: the engine writes the rates as percentages, and the page talks in cents
 *   per dollar everywhere else. The figures are still the engine's.
 */
export function noticeMessage(
  warning: PlannerWarning,
  result: PlannerResult,
  hint: WhatIf | null,
  options: ReasonOptions = {},
): string {
  if (warning.code === 'LEVER_LIMITS_PLAN' || warning.code === 'BUDGET_LIMITS_PLAN') {
    return stopReason(result, hint, options);
  }
  if (warning.code === 'BELOW_MIN_SAVING_RATE') {
    const most = result.baseline.marginalRate;
    const asked = centsPerDollar(result.input.preferences.minSavingRate);
    // Nobody is told they "set" a minimum that is the page's default.
    const minimum = options.defaultMinimum ? `the default minimum of ${asked}` : `the ${asked} minimum you set`;
    return (
      `Each extra dollar would save ${centsPerDollar(most)} or less in tax, below ${minimum}, so nothing is ` +
      'recommended. Choose Every tax dollar under "How far down the ladder?" to see ' +
      // A foreigner is told what those dollars cost on the way out wherever the page points to them.
      (options.deeperCaveat ? `a plan with these smaller savings. ${options.deeperCaveat}` : 'these smaller savings.')
    );
  }
  return warning.message;
}

/**
 * The engine warnings to list, most serious first.
 * - When the reliefs are already over the cap, the engine says so twice (once about the reliefs, once about
 *   the plan); the first says everything the second does.
 * - Once the deadline has passed, the notes about what stops the plan and how to save more are left out: there
 *   is nothing left to change for that year.
 * - The cautions that decide whether a recommended dollar earns relief are shown with the recommendation, so
 *   they are not said a second time here.
 * - The note that CPF top-ups are not open to a foreigner is the one line under the lock-up facts.
 */
export function listedWarnings(result: PlannerResult): PlannerWarning[] {
  const codes = new Set(result.warnings.map((w) => w.code));
  const past = deadlinePassed(result);
  const skip = new Set<string>(PLAN_CAUTION_CODES);
  if (!cpfOpen(result)) skip.add('FOREIGNER_NO_CPF');
  if (codes.has('RELIEF_CAP_EXCEEDED_BASELINE')) skip.add('RELIEF_CAP_LIMITS_PLAN');
  if (past) for (const code of ['LEVER_LIMITS_PLAN', 'BUDGET_LIMITS_PLAN', 'BELOW_MIN_SAVING_RATE']) skip.add(code);
  return SEVERITY_ORDER.flatMap((sev) => result.warnings.filter((w) => w.severity === sev && !skip.has(w.code)));
}

export function BeforeYouTransfer(
  props: SectionProps & { hint: WhatIf | null; options: ReasonOptions },
): JSX.Element {
  const { result, hint, options } = props;
  const warnings = listedWarnings(result);
  // Only the schemes that are open to this person get a column: a foreigner sees SRS alone.
  const levers = usableLevers(result);
  // The engine's wording, shared with the workbook: rendered as it comes, never rewritten here.
  const facts = factsFor(result);
  const notOpen = cpfOpen(result) ? null : (result.warnings.find((w) => w.code === 'FOREIGNER_NO_CPF')?.message ?? null);
  return (
    <div class="before">
      {warnings.length > 0 ? (
        <>
          <h3 class="sub-title">About your numbers</h3>
          <ul class="notices" data-testid="warnings">
            {warnings.map((w) => (
              <Notice key={w.code} warning={w} message={noticeMessage(w, result, hint, options)} />
            ))}
          </ul>
        </>
      ) : null}

      <h3 class="sub-title">What locking the money away means</h3>
      {levers.length > 0 ? (
        <TableScroll label="Lock-up facts for each scheme">
          <table class="table table-facts" data-testid="facts-table">
            <caption class="sr-only">What each scheme locks away, earns and costs later</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span class="sr-only">Fact</span>
                </th>
                {levers.map((l) => (
                  <th scope="col" key={l}>
                    {LEVER_NAME[l]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {facts.map((row) => (
                <tr key={row.id} data-fact={row.id}>
                  <th scope="row">{row.label}</th>
                  {levers.map((l) => (
                    <td key={l} data-label={LEVER_NAME[l]}>
                      {row.values[l]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      ) : (
        <p class="empty">None of the schemes is open to you on these numbers.</p>
      )}
      {notOpen ? (
        <p class="prose small" data-testid="facts-not-open">
          {notOpen}
        </p>
      ) : null}

      <h3 class="sub-title">Check before you move money</h3>
      <ul class="plain-list" data-testid="transfer-cautions">
        {cautionsFor(result).map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources and assumptions
// ---------------------------------------------------------------------------

export function Sources({ result }: SectionProps): JSX.Element {
  const { rules, levers } = result;
  return (
    <div class="sources">
      <div class="sources-grid">
        <div>
          <h3 class="sub-title">
            Rule values used for YA{rules.ya}
            {rules.status === 'projected' ? <span class="tag tag-caution">Projected</span> : null}
          </h3>
          <dl class="rows rows-plain">
            <Row label="Overall cap on personal reliefs" value={dollars(rules.personalReliefCap)} />
            <Row label="SRS cap for you" value={dollars(levers.srs.statutoryCap)} />
            {/* CPF figures only for people the CPF rules apply to: a foreigner on a work pass has no CPF. */}
            {levers.cpfSelf.eligible ? (
              <Row label="CPF cash top-up relief, self" value={dollars(levers.cpfSelf.statutoryCap)} />
            ) : null}
            {levers.cpfFamily.eligible ? (
              <Row label="CPF cash top-up relief, family" value={dollars(levers.cpfFamily.statutoryCap)} />
            ) : null}
            {result.cpf.source !== 'none' ? (
              <>
                <Row label="Monthly salary ceiling for CPF" value={dollars(rules.cpf.owCeilingMonthly)} />
                <Row label="Yearly wage ceiling for CPF" value={dollars(rules.cpf.annualWageCeiling)} />
              </>
            ) : null}
            {levers.cpfSelf.eligible || levers.cpfFamily.eligible ? (
              <>
                <Row label="Full Retirement Sum" value={dollars(rules.cpfTopUp.fullRetirementSum)} />
                <Row label="Enhanced Retirement Sum" value={dollars(rules.cpfTopUp.enhancedRetirementSum)} />
                <Row
                  label="Basic Healthcare Sum, aged 65 or under"
                  value={dollars(rules.cpfTopUp.basicHealthcareSum)}
                />
              </>
            ) : null}
            <Row label="Donations deducted at" value={pct(rules.donationDeductionMultiplier)} />
            <Row label="Last day to contribute" value={longDate(rules.contributionDeadline)} />
          </dl>
        </div>
        <div>
          <h3 class="sub-title">Where the rules come from</h3>
          <ul class="link-list" data-testid="sources-list">
            {sourcesFor(result).map((s) => (
              <li key={s.url}>
                <a href={s.url} target="_blank" rel="noopener">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h3 class="sub-title">Assumptions</h3>
      <ul class="plain-list">
        {rules.statusNotes.map((note) => (
          <li key={note}>{note}</li>
        ))}
        {approximations(result).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <h3 class="sub-title">What this does not model</h3>
      <ul class="plain-list" data-testid="not-modelled">
        {notModelledFor(result).map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <p class="disclaimer" data-testid="disclaimer">
        {DISCLAIMER}
      </p>
      <p class="prose small">
        The calculator runs in your browser. Your numbers are saved on this device only and are not sent anywhere.
        It never asks for your name, NRIC or account numbers. The page asks Google Fonts for its two typefaces
        and requests nothing else; it works the same without them.
      </p>
    </div>
  );
}

/** The foot of the page: what this is, which version, and the one link to the paid workbook when there is one. */
export function PageFoot(): JSX.Element {
  return (
    <footer class="page-foot" data-testid="page-foot">
      <p>
        Singapore Tax Optimiser
        {VERSION ? (
          <>
            {' · '}
            <span data-testid="version">version {VERSION}</span>
          </>
        ) : null}
        {' · '}Estimate only, not tax advice
      </p>
      {BUY_URL ? (
        <p data-testid="shop-link-foot">
          <a href={BUY_URL} target="_blank" rel="noopener">
            {BUY_LABEL}
          </a>
        </p>
      ) : null}
    </footer>
  );
}

/** "Days left" phrasing shared by the readout bar. */
export function daysLeftText(result: PlannerResult): string {
  const d = result.monthlyPlan.daysToDeadline;
  if (d < 0) return 'deadline passed';
  return d === 0 ? 'last day today' : `${countOf(d, 'day')} left`;
}
