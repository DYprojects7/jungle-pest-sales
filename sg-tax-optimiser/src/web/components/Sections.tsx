import type { ComponentChildren, JSX } from 'preact';
import type { LeverId, PlannerResult, PlannerWarning, Scenario, TaxComputation } from '../../engine/types';
import { bandRows } from '../bands';
import { cents, centsPerDollar, countOf, dayAndMonth, dollars, longDate, monthLabel, pct } from '../format';
import { SIMULATOR_STEPS } from '../state';
import {
  APPROXIMATIONS,
  DISCLAIMER,
  LEVERS,
  LEVER_NAME,
  LEVER_SHORT,
  NOT_MODELLED,
  SCENARIO_NAME,
  eligibilityCautions,
  lockUpFacts,
} from '../text';
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

export function Compare({ result }: SectionProps): JSX.Element {
  const recommended = result.scenarios.find((s) => s.id === 'recommended');
  const rows = result.scenarios.filter((s) => s.id === 'none' || s.id === 'recommended' || s.totalContribution > 0);
  const levers = usableLevers(result).filter((l) => rows.some((s) => s.contributions[l] > 0));
  return (
    <TableScroll label="Options compared">
      <table class="table table-wide" data-testid="scenario-table">
        <caption class="sr-only">Ready-made options on the same numbers, compared with your plan</caption>
        <thead>
          <tr>
            <th scope="col">Option</th>
            {levers.map((l) => (
              <th scope="col" class="num" key={l}>
                {LEVER_SHORT[l]}
              </th>
            ))}
            <th scope="col" class="num">
              Cash locked away
            </th>
            <th scope="col" class="num">
              Tax
            </th>
            <th scope="col" class="num">
              Tax saved
            </th>
            <th scope="col" class="num">
              Saved per dollar
            </th>
            <th scope="col" class="num">
              Wasted dollars
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => {
            const isPlan = s.id === 'recommended';
            const twin = !isPlan && s.id !== 'none' && recommended !== undefined && sameSplit(s, recommended);
            return (
              <tr key={s.id} class={isPlan ? 'is-plan' : undefined} data-scenario={s.id}>
                <th scope="row">
                  {SCENARIO_NAME[s.id]}
                  {isPlan ? (
                    <span class="cell-note">
                      <span class="tag tag-plan">Recommended</span>
                    </span>
                  ) : null}
                  {twin ? <span class="cell-note">Same as your plan</span> : null}
                </th>
                {levers.map((l) => (
                  <td class="num" key={l}>
                    {dollars(s.contributions[l])}
                  </td>
                ))}
                <td class="num">{dollars(s.totalContribution)}</td>
                <td class="num">{cents(s.taxPayable)}</td>
                <td class="num">{cents(s.taxSaved)}</td>
                <td class="num">{s.totalContribution > 0 ? centsPerDollar(s.savingRate) : 'n/a'}</td>
                <td class="num">
                  {s.wastedContribution > 0 ? (
                    <span class="tag tag-neg">{dollars(s.wastedContribution)} saves nothing</span>
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

export function MonthlyPlanView({ result }: SectionProps): JSX.Element {
  const { monthlyPlan: mp, plan: p, rules } = result;
  const levers = LEVERS.filter((l) => p.contributions[l] > 0);
  const passed = mp.daysToDeadline < 0;
  return (
    <div class="monthly">
      <div class="countdown" data-testid="countdown">
        {passed ? (
          <>
            <span class="countdown-figure">0</span>
            <span class="countdown-text">
              days left. The deadline was {longDate(mp.deadline)}. Money you put in now counts for the following year.
            </span>
          </>
        ) : (
          <>
            <span class="countdown-figure" data-testid="days-left">
              {mp.daysToDeadline}
            </span>
            <span class="countdown-text">
              {mp.daysToDeadline === 1 ? 'day' : 'days'} until {longDate(mp.deadline)}, the last day a contribution
              counts for YA{rules.ya}
            </span>
          </>
        )}
      </div>

      {mp.schedule.length > 0 ? (
        <TableScroll label="Monthly set-aside schedule">
          <table class="table table-fit" data-testid="monthly-table">
            <caption class="sr-only">How much to set aside each month until the deadline</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                {levers.map((l) => (
                  <th scope="col" class="num" key={l}>
                    {LEVER_SHORT[l]}
                  </th>
                ))}
                <th scope="col" class="num">
                  Set aside
                </th>
              </tr>
            </thead>
            <tbody>
              {mp.schedule.map((row) => (
                <tr key={row.month}>
                  <th scope="row">{monthLabel(row.month)}</th>
                  {levers.map((l) => (
                    <td class="num" key={l}>
                      {dollars(row.amounts[l])}
                    </td>
                  ))}
                  <td class="num">{dollars(row.total)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr class="is-total">
                <th scope="row">Total</th>
                {levers.map((l) => (
                  <td class="num" key={l}>
                    {dollars(p.contributions[l])}
                  </td>
                ))}
                <td class="num">{dollars(p.totalContribution)}</td>
              </tr>
            </tfoot>
          </table>
        </TableScroll>
      ) : (
        <p class="empty">
          {passed ? 'There is nothing left to schedule for this income year.' : 'Nothing to set aside: the plan is S$0.'}
        </p>
      )}

      {p.totalContribution > 0 ? (
        <p class="prose" data-testid="full-year">
          Start in January next time and the same plan is <b>{dollars(mp.fullYearMonthly.total)} a month</b> over
          twelve months
          {levers.length > 1
            ? ` (${levers.map((l) => `${LEVER_SHORT[l]} ${dollars(mp.fullYearMonthly[l])}`).join(', ')})`
            : ''}
          .
        </p>
      ) : null}

      <ul class="plain-list">
        <li>
          SRS: banks stop taking same-day contributions before midnight on {dayAndMonth(mp.deadline)}, some as early
          as 7pm. A transfer after the cut-off counts for the next year.
        </li>
        <li>
          CPF top-ups count on the day the CPF Board receives the money, not the day you send it. Transfer a few
          working days early.
        </li>
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Every extra S$1,000
// ---------------------------------------------------------------------------

export function Simulator(props: SectionProps & { step: number; onStep: (step: number) => void }): JSX.Element {
  const { result, step, onStep } = props;
  const rows = result.simulator;
  const levers = usableLevers(result).filter((l) => rows.some((r) => r.split[l] > 0));
  const used = result.input.preferences.simulatorStep ?? step;
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
                  {levers.map((l) => (
                    <th scope="col" class="num" key={l}>
                      {LEVER_SHORT[l]}
                    </th>
                  ))}
                  <th scope="col" class="num">
                    Tax
                  </th>
                  <th scope="col" class="num">
                    Tax saved so far
                  </th>
                  <th scope="col" class="num">
                    This step saves
                  </th>
                  <th scope="col" class="num">
                    Per dollar
                  </th>
                  <th scope="col">In your plan</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.contribution} class={r.withinPlan && r.contribution > 0 ? 'is-plan' : undefined}>
                    <th scope="row" class="nowrap">
                      {dollars(r.contribution)}
                    </th>
                    {levers.map((l) => (
                      <td class="num" key={l}>
                        {dollars(r.split[l])}
                      </td>
                    ))}
                    <td class="num">{cents(r.taxPayable)}</td>
                    <td class="num">{cents(r.taxSaved)}</td>
                    <td class="num">{i === 0 ? 'n/a' : cents(r.stepSaving)}</td>
                    <td class="num">{i === 0 ? 'n/a' : centsPerDollar(r.stepRate)}</td>
                    <td class="nowrap">{r.contribution === 0 ? 'Start' : r.withinPlan ? 'Yes' : 'Beyond it'}</td>
                  </tr>
                ))}
              </tbody>
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
  kind?: 'sub' | 'strong' | 'total' | 'grand' | 'lost';
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

  const reliefs: WorkingRow[] = [
    workingRow('Earned Income Relief', (t) => t.reliefs.earnedIncome, result),
    workingRow('CPF relief, compulsory employee share', (t) => t.reliefs.cpf, result),
    workingRow('SRS relief', (t) => t.reliefs.srs, result),
    workingRow('CPF cash top-up relief, self', (t) => t.reliefs.cpfTopUpSelf, result),
    workingRow('CPF cash top-up relief, family', (t) => t.reliefs.cpfTopUpFamily, result),
    workingRow('Other reliefs', (t) => t.reliefs.other, result),
    workingRow('Reliefs before the cap', (t) => t.reliefs.totalBeforeCap, result, dollars, 'total'),
  ];
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
  tax.push(workingRow('Rate on your next dollar of income', (t) => t.marginalRate, result, (n) => pct(n)));
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
                  <td class={`num${r.before !== r.after ? ' changed' : ''}`}>{r.after}</td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </TableScroll>

      <h3 class="sub-title">The rate table, band by band</h3>
      <TableScroll label="Tax by band before and after the plan">
        <table class="table table-wide" data-testid="band-table">
          <caption class="sr-only">How much of your chargeable income falls in each tax band, and the tax on it</caption>
          <thead>
            <tr>
              <th scope="col">Chargeable income band</th>
              <th scope="col" class="num">
                Rate
              </th>
              <th scope="col" class="num">
                In band now
              </th>
              <th scope="col" class="num">
                Tax now
              </th>
              <th scope="col" class="num">
                In band with the plan
              </th>
              <th scope="col" class="num">
                Tax with the plan
              </th>
            </tr>
          </thead>
          <tbody>
            {bands.map((band) => (
              <tr key={band.from}>
                <th scope="row" class="nowrap">
                  {band.to === null
                    ? `Above ${dollars(band.from)}`
                    : band.from === 0
                      ? `First ${dollars(band.to)}`
                      : `${dollars(band.from)} to ${dollars(band.to)}`}
                </th>
                <td class="num">{pct(band.rate)}</td>
                <td class="num">{dollars(band.before.income)}</td>
                <td class="num">{cents(band.before.tax)}</td>
                <td class={`num${band.before.income !== band.after.income ? ' changed' : ''}`}>
                  {dollars(band.after.income)}
                </td>
                <td class={`num${band.before.tax !== band.after.tax ? ' changed' : ''}`}>{cents(band.after.tax)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr class="is-total">
              <th scope="row">Tax from the rate table</th>
              <td />
              <td class="num">{dollars(b.chargeableIncome)}</td>
              <td class="num">{cents(b.grossTax)}</td>
              <td class="num">{dollars(o.chargeableIncome)}</td>
              <td class="num">{cents(o.grossTax)}</td>
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

export function Notice({ warning }: { warning: PlannerWarning }): JSX.Element {
  return (
    <li class={`notice notice-${warning.severity}`} data-code={warning.code}>
      <span class={`tag tag-${warning.severity}`}>{SEVERITY_TAG[warning.severity]}</span>
      <p>{warning.message}</p>
    </li>
  );
}

export function BeforeYouTransfer({ result }: SectionProps): JSX.Element {
  const warnings = SEVERITY_ORDER.flatMap((sev) => result.warnings.filter((w) => w.severity === sev));
  const levers = usableLevers(result);
  const facts = lockUpFacts(result);
  return (
    <div class="before">
      {warnings.length > 0 ? (
        <>
          <h3 class="sub-title">About your numbers</h3>
          <ul class="notices" data-testid="warnings">
            {warnings.map((w) => (
              <Notice key={w.code} warning={w} />
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
                <tr key={row.label}>
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

      <h3 class="sub-title">Check before you move money</h3>
      <ul class="plain-list">
        {eligibilityCautions(result).map((text) => (
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
            <Row label="CPF top-up relief, self" value={dollars(rules.cpfTopUp.selfReliefCap)} />
            <Row label="CPF top-up relief, family" value={dollars(rules.cpfTopUp.familyReliefCap)} />
            <Row label="Monthly salary ceiling for CPF" value={dollars(rules.cpf.owCeilingMonthly)} />
            <Row label="Yearly wage ceiling for CPF" value={dollars(rules.cpf.annualWageCeiling)} />
            <Row label="Full Retirement Sum" value={dollars(rules.cpfTopUp.fullRetirementSum)} />
            <Row label="Basic Healthcare Sum" value={dollars(rules.cpfTopUp.basicHealthcareSum)} />
            <Row label="Donations deducted at" value={pct(rules.donationDeductionMultiplier)} />
            <Row label="Last day to contribute" value={longDate(rules.contributionDeadline)} />
          </dl>
        </div>
        <div>
          <h3 class="sub-title">Where the rules come from</h3>
          <ul class="link-list" data-testid="sources-list">
            {rules.sources.map((s) => (
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
        {APPROXIMATIONS.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <h3 class="sub-title">What this does not model</h3>
      <ul class="plain-list">
        {NOT_MODELLED.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>

      <p class="disclaimer" data-testid="disclaimer">
        {DISCLAIMER}
      </p>
      <p class="prose small">
        The calculator runs in your browser. Your numbers are saved on this device only and are not sent anywhere.
        It never asks for your name, NRIC or account numbers.
      </p>
    </div>
  );
}

/** "Days left" phrasing shared by the readout bar. */
export function daysLeftText(result: PlannerResult): string {
  const d = result.monthlyPlan.daysToDeadline;
  return d < 0 ? 'deadline passed' : `${countOf(d, 'day')} left`;
}
