import type { JSX } from 'preact';
import { SUPPORTED_INCOME_YEARS, getRules } from '../../engine';
import type { PlannerResult, PrYear, ReliefCatalogItem, Residency } from '../../engine/types';
import { centsPerDollar, dayAndMonth, dollars, monthName, pct } from '../format';
import type { Depth, Order, PayMode, ReliefMode, UiState } from '../state';
import {
  customRateOf,
  customRateOptions,
  exampleLeft,
  monthlyWage,
  oddPay,
  reliefItemAmount,
  reliefsUntouched,
  switchPayMode,
  switchReliefMode,
} from '../state';
import {
  DEPTHS,
  LEVERS,
  ORDER_LABEL,
  balanceCaution,
  depthExplanation,
  depthLabel,
  fact,
  factsFor,
  familyCaution,
  foreignerDepthNote,
  orderWhy,
  residencyHint,
} from '../text';
import { CheckField, NumberField, RadioList, SegmentedField, SelectField } from './Controls';

/** Largest amount a money field accepts. Far above any salary; it only keeps typos from running away. */
const MAX_AMOUNT = 100_000_000;
const MAX_AMOUNT_NOTE = `Enter an amount up to ${dollars(MAX_AMOUNT)}.`;

interface InputsProps {
  ui: UiState;
  /** The opening example, to tell which figures are still its own. */
  example: UiState;
  result: PlannerResult;
  update: (patch: Partial<UiState>) => void;
}

/** Shown beside a field that still holds the example's figure once the person has started on their own. */
const EXAMPLE_FLAG = 'Example value';

export function Inputs({ ui, example, result, update }: InputsProps): JSX.Element {
  const { rules, levers, cpf, baseline } = result;
  const year = rules.incomeYear;
  const foreigner = ui.residency === 'foreigner';
  const crossesCpfBand = rules.cpf.fullRates.some((band) => band.maxAge === ui.age);
  const warning = (code: string): string | null => result.warnings.find((w) => w.code === code)?.message ?? null;
  const left = exampleLeft(ui, example);
  const flag = (name: string): string | null => (left.includes(name) ? EXAMPLE_FLAG : null);
  const facts = factsFor(result);
  // From 55 the engine asks for the top-up that can still earn relief: one of these two notes is then present,
  // the first while the field is empty and the second once it is filled.
  const roomWaiting = warning('CPF_SELF_ROOM_UNCONFIRMED') !== null;
  const roomAsked = roomWaiting || warning('AGE_55_PLUS_TOPUP') !== null;
  // What to count in a family top-up, with the year's matched amounts: the engine's own caution, whole.
  const familyHint = familyCaution(result);
  // The custom minimum: the rate the person picked, or their default until they have picked one.
  const customRate = customRateOf(ui);
  // The helper is open on the untouched example: nothing is itemised and the example's total is still counted.
  const helperOnExample = ui.reliefMode === 'itemised' && reliefsUntouched(ui);
  // "Which first?" only means something when there is more than one scheme to put in order.
  const severalSchemes = LEVERS.filter((l) => levers[l].eligible).length > 1;

  const setPayMode = (mode: PayMode): void => {
    if (mode === ui.payMode) return;
    // Keep the same pay, and bring back the figure that was typed in this mode if it has not been changed since.
    update(switchPayMode(ui, mode));
  };

  const annual = ui.payMode === 'annual';
  const partYear = ui.monthsWorked < 12;
  const odd = oddPay(ui);
  // Someone with no CPF (a foreigner on a work pass) is not told their pay is "before CPF".
  const beforeCpf = foreigner ? '' : ', before CPF';
  const salaryHint = !annual
    ? `Basic pay and fixed allowances${beforeCpf}.`
    : partYear
      ? `What twelve months would pay${beforeCpf}. Only the ${ui.monthsWorked === 1 ? 'month' : `${ui.monthsWorked} months`} you worked ${ui.monthsWorked === 1 ? 'is' : 'are'} counted.`
      : `Twelve months of basic pay and fixed allowances${beforeCpf}. Treated as ${dollars(monthlyWage(ui))} a month` +
        (odd > 0 ? `, with the odd ${dollars(odd)} counted as extra pay.` : '.');

  const setItem = (id: string, value: number): void => {
    update({ reliefItems: { ...ui.reliefItems, [id]: value } });
  };

  const yearOptions = SUPPORTED_INCOME_YEARS.slice()
    .sort((a, b) => b - a)
    .map((y) => {
      const r = getRules(y);
      return { value: y, label: `${y} (YA${r.ya})${r.status === 'projected' ? ', projected rules' : ''}` };
    });

  return (
    <div class="groups">
      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-about">
        <h3 class="group-title" id="g-about">
          About you
        </h3>
        <SegmentedField<Residency>
          name="residency"
          legend="Residency"
          value={ui.residency}
          options={[
            { value: 'citizen', label: 'Citizen' },
            { value: 'pr', label: 'PR' },
            { value: 'foreigner', label: 'Foreigner' },
          ]}
          onChange={(residency) => update({ residency })}
          hint={<span data-testid="residency-hint">{residencyHint(ui.residency, year)}</span>}
        />
        {ui.residency === 'pr' ? (
          <SegmentedField<PrYear>
            name="prYear"
            legend="Years as a PR"
            value={ui.prYear}
            options={[
              { value: 1, label: '1st year' },
              { value: 2, label: '2nd year' },
              { value: 3, label: '3rd year onwards' },
            ]}
            // Each option as wide as its words, with the spare room shared out: all three fit on one line at 360px.
            template="auto auto auto"
            onChange={(prYear) => update({ prYear })}
            hint="PRs pay lower CPF rates in their first two years. If you opted for full rates, choose 3rd year onwards."
          />
        ) : null}
        <NumberField
          id="age"
          label={`Age on 31 Dec ${year}`}
          value={ui.age}
          min={15}
          max={100}
          minNote="Enter an age from 15 to 100."
          maxNote="Enter an age from 15 to 100."
          suffix="years"
          flag={flag('age')}
          onChange={(age) => update({ age })}
        />
        {crossesCpfBand && !foreigner ? (
          <SelectField
            id="birthMonth"
            label="Birth month"
            value={ui.birthMonth}
            options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: monthName(i + 1) }))}
            onChange={(v) => update({ birthMonth: Number(v) })}
            hint={`You turn ${ui.age} this year, and your CPF rate changes from the month after your birthday.`}
          />
        ) : null}
        {yearOptions.length > 1 ? (
          <SelectField
            id="incomeYear"
            label="Income year"
            value={ui.incomeYear}
            options={yearOptions}
            onChange={(v) => update({ incomeYear: Number(v) })}
            hint="The year you earn the income and make the contributions. It is assessed the year after."
          />
        ) : null}
        {rules.status === 'projected' ? (
          <p class="field-note">
            Rules for {year} are projected from what has been announced so far. Treat the figures as provisional.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-income">
        <div class="group-head">
          <h3 class="group-title" id="g-income">
            Income
          </h3>
          <SegmentedField<PayMode>
            name="payMode"
            legend="Enter salary as"
            hideLegend
            small
            value={ui.payMode}
            options={[
              { value: 'monthly', label: 'Monthly' },
              { value: 'annual', label: 'Annual' },
            ]}
            onChange={setPayMode}
          />
        </div>
        <NumberField
          id="salary"
          testid="salary"
          label={!annual ? 'Monthly salary' : partYear ? 'Full-year salary' : 'Annual salary'}
          prefix="S$"
          value={ui.salary}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          flag={flag('salary')}
          onChange={(salary) => update({ salary, salaryOther: null })}
          hint={salaryHint}
        />
        <NumberField
          id="bonus"
          testid="bonus"
          label={`Bonus and other extra pay in ${year}`}
          prefix="S$"
          value={ui.bonus}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          flag={flag('bonus')}
          onChange={(bonus) => update({ bonus })}
          hint="13th month, bonuses, and commissions or incentives paid less often than monthly. Those paid every month belong in the salary."
        />
        <SelectField
          id="monthsWorked"
          label={`Months worked in ${year}`}
          value={ui.monthsWorked}
          options={Array.from({ length: 12 }, (_, i) => ({
            value: 12 - i,
            label: 12 - i === 12 ? '12 (the whole year)' : String(12 - i),
          }))}
          onChange={(v) => update({ monthsWorked: Number(v) })}
          hint={ui.monthsWorked < 12 ? 'Counted as the last months of the year.' : undefined}
        />
        <div class="aside-figures">
          <p class="aside-figure">
            <span>Pay counted for {year}</span>
            <strong data-testid="pay-counted">{dollars(baseline.employmentIncome)}</strong>
          </p>
          {!foreigner ? (
            <p class="aside-figure">
              <span>
                {cpf.source === 'override' ? 'Employee CPF used (your figure)' : 'Employee CPF for the year (estimated)'}
              </span>
              <strong data-testid="cpf-employee">{dollars(cpf.employeeContribution)}</strong>
            </p>
          ) : null}
        </div>
        <details class="more">
          <summary>More options</summary>
          <div class="more-body">
            <NumberField
              id="otherIncome"
              label="Other taxable income"
              prefix="S$"
              value={ui.otherIncome}
              max={MAX_AMOUNT}
              maxNote={MAX_AMOUNT_NOTE}
              onChange={(otherIncome) => update({ otherIncome })}
              hint={`Net rental income or taxable benefits, for example.${foreigner ? '' : ' No CPF is paid on it.'}`}
            />
            <NumberField
              id="expenses"
              label="Employment expenses"
              prefix="S$"
              value={ui.expenses}
              max={MAX_AMOUNT}
              maxNote={MAX_AMOUNT_NOTE}
              onChange={(expenses) => update({ expenses })}
              hint="Allowable work expenses your employer did not reimburse."
            />
            <NumberField
              id="donations"
              label="Donations"
              prefix="S$"
              value={ui.donations}
              max={MAX_AMOUNT}
              maxNote={MAX_AMOUNT_NOTE}
              onChange={(donations) => update({ donations })}
              hint={`Qualifying cash donations in ${year}. They are deducted at ${pct(rules.donationDeductionMultiplier)}.`}
            />
            {!foreigner ? (
              <CheckField
                id="cpfOverrideOn"
                label="Use my actual employee CPF for the year"
                checked={ui.cpfOverrideOn}
                onChange={(on) =>
                  update(
                    on && ui.cpfOverride === null
                      ? { cpfOverrideOn: true, cpfOverride: cpf.employeeContribution }
                      : { cpfOverrideOn: on },
                  )
                }
                detail="From your payslips or CPF statement. Only the compulsory employee share counts."
              >
                {ui.cpfOverrideOn ? (
                  <NumberField
                    optional
                    id="cpfOverride"
                    label="Employee CPF for the year"
                    prefix="S$"
                    placeholder="Use the estimate"
                    value={ui.cpfOverride}
                    max={MAX_AMOUNT}
                    maxNote={MAX_AMOUNT_NOTE}
                    onChange={(cpfOverride) => update({ cpfOverride })}
                    hint="Leave it empty to use the estimate."
                    caution={
                      warning('CPF_OVERRIDE_ABOVE_MAX') ??
                      (ui.cpfOverride === 0
                        ? 'S$0 means no CPF relief at all. Clear the field to use the estimate instead.'
                        : null)
                    }
                  />
                ) : null}
              </CheckField>
            ) : null}
          </div>
        </details>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* Asked straight after the pay, not at the end of the form: it decides whether the answer is one the
          person can afford. */}
      <section class="group" aria-labelledby="g-cash">
        <h3 class="group-title" id="g-cash">
          Cash to spare
        </h3>
        <NumberField
          optional
          id="cashLimit"
          label="How much cash can you spare this year? (optional)"
          prefix="S$"
          placeholder="No limit"
          value={ui.cashLimit}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          onChange={(cashLimit) => update({ cashLimit })}
          hint={`The most you are willing to lock away before ${dayAndMonth(rules.contributionDeadline)}. The plan never goes above it. Leave empty for no limit.`}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-existing">
        <h3 class="group-title" id="g-existing">
          Already contributed in {year}
        </h3>
        <p class="field-hint" data-testid="existing-hint">
          {foreigner
            ? 'Include anything your employer paid into your SRS.'
            : 'Include anything your employer paid into your SRS or topped up to your CPF in cash.'}
        </p>
        <NumberField
          id="existingSrs"
          label="SRS"
          prefix="S$"
          value={ui.existingSrs}
          max={levers.srs.statutoryCap > 0 ? levers.srs.statutoryCap : MAX_AMOUNT}
          maxNote={
            levers.srs.statutoryCap > 0 ? `SRS is capped at ${dollars(levers.srs.statutoryCap)} a year.` : MAX_AMOUNT_NOTE
          }
          onChange={(existingSrs) => update({ existingSrs })}
        />
        {levers.cpfSelf.eligible ? (
          <NumberField
            id="existingCpfSelf"
            label="CPF cash top-up to yourself"
            prefix="S$"
            value={ui.existingCpfSelf}
            max={levers.cpfSelf.statutoryCap}
            maxNote={`Only the first ${dollars(levers.cpfSelf.statutoryCap)} of top-ups to yourself earns relief each year, so that is what counts.`}
            onChange={(existingCpfSelf) => update({ existingCpfSelf })}
          />
        ) : null}
        {levers.cpfFamily.eligible ? (
          <NumberField
            id="existingCpfFamily"
            label="CPF cash top-up to family"
            prefix="S$"
            value={ui.existingCpfFamily}
            max={levers.cpfFamily.statutoryCap}
            maxNote={`Only the first ${dollars(levers.cpfFamily.statutoryCap)} of top-ups to family earns relief each year, so that is what counts.`}
            onChange={(existingCpfFamily) => update({ existingCpfFamily })}
            hint="Leave out any part the Government matched."
          />
        ) : null}
        {warning('EXISTING_EXCEEDS_CAP') ? <p class="field-note">{warning('EXISTING_EXCEEDS_CAP')}</p> : null}
      </section>

      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-reliefs">
        <div class="group-head">
          <h3 class="group-title" id="g-reliefs">
            Other reliefs
          </h3>
          <SegmentedField<ReliefMode>
            name="reliefMode"
            legend="Enter other reliefs as"
            hideLegend
            small
            value={ui.reliefMode}
            options={[
              { value: 'total', label: 'One total' },
              { value: 'itemised', label: 'Itemise' },
            ]}
            onChange={(reliefMode) => update(switchReliefMode(ui, reliefMode, rules))}
          />
        </div>
        {ui.reliefMode === 'total' ? (
          <NumberField
            id="reliefTotal"
            label="Other reliefs in total"
            prefix="S$"
            value={ui.reliefTotal}
            max={rules.personalReliefCap}
            maxNote={`All personal reliefs together are capped at ${dollars(rules.personalReliefCap)}.`}
            flag={flag('other reliefs')}
            onChange={(reliefTotal) => update({ reliefTotal })}
            hint={`Spouse, child, parent, NSman and similar reliefs. Leave out ${foreigner ? '' : 'CPF, '}SRS and Earned Income Relief: those are worked out for you.`}
          />
        ) : (
          <ReliefHelper
            catalog={rules.reliefCatalog}
            values={ui.reliefItems}
            total={result.input.otherReliefs}
            onChange={setItem}
            // On the untouched example the helper opens empty and the example's total is still the one counted.
            exampleTotal={helperOnExample ? ui.reliefTotal : null}
            flag={flag('other reliefs')}
            onNone={() => update({ reliefItems: {} })}
          />
        )}
        <CheckField
          id="hasPtr"
          label="I have unused Parenthood Tax Rebate"
          checked={ui.hasPtr}
          onChange={(hasPtr) => update({ hasPtr })}
          detail={`Any Parenthood Tax Rebate you have not used up, including the rebate for a child born in ${year}. No amount is needed: ticking this adds a caution beside the plan.`}
        />
      </section>

      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-prefs">
        <h3 class="group-title" id="g-prefs">
          Your preferences
        </h3>

        <fieldset class="field">
          <legend class="field-label">Schemes to use</legend>
          <div class="check-list">
            <CheckField
              id="useSrs"
              label="SRS"
              checked={ui.useSrs && levers.srs.eligible}
              disabled={!levers.srs.eligible}
              onChange={(useSrs) => update({ useSrs })}
              detail={
                levers.srs.eligible
                  ? `Relief on up to ${dollars(levers.srs.statutoryCap)} a year.`
                  : `You must be ${rules.srs.minAge} or over to contribute to SRS.`
              }
            />
            {levers.cpfSelf.eligible ? (
              <CheckField
                id="useCpfSelf"
                label="CPF cash top-up to yourself"
                checked={ui.useCpfSelf}
                onChange={(useCpfSelf) => update({ useCpfSelf })}
                detail={`Relief on up to ${dollars(levers.cpfSelf.statutoryCap)} a year.`}
              >
                {ui.useCpfSelf ? (
                  <NumberField
                    optional
                    id="cpfSelfRoom"
                    // Optional below 55; asked for from 55, where the CPF Board accepts top-ups that earn no relief.
                    label={`Top-up that can still earn relief${roomAsked ? '' : ' (optional)'}`}
                    prefix="S$"
                    placeholder={roomAsked ? 'Enter a figure' : 'Not sure'}
                    needed={roomAsked}
                    value={ui.cpfSelfRoom}
                    max={MAX_AMOUNT}
                    maxNote={MAX_AMOUNT_NOTE}
                    onChange={(cpfSelfRoom) => update({ cpfSelfRoom })}
                    hint={
                      roomAsked
                        ? // Where to find the figure and why it matters are the engine's own caution, whole (the
                          // same line is in the checklist under "Before you transfer").
                          `${balanceCaution(result)} Enter S$0 if you have already set aside the Full Retirement Sum (${dollars(rules.cpfTopUp.fullRetirementSum)}).`.trim()
                        : `${fact(facts, 'limits', 'cpfSelf')} Leave this empty if those limits are far off.`
                    }
                    caution={roomWaiting ? 'Until this is filled in, your own CPF is left out of the plan.' : null}
                  />
                ) : null}
              </CheckField>
            ) : null}
            {levers.cpfFamily.eligible ? (
              <CheckField
                id="useCpfFamily"
                label="CPF cash top-up to family"
                checked={ui.useCpfFamily}
                onChange={(useCpfFamily) => update({ useCpfFamily })}
                detail={`Relief on up to ${dollars(levers.cpfFamily.statutoryCap)} a year for parents, grandparents and some spouses or siblings.`}
              >
                {ui.useCpfFamily ? (
                  <NumberField
                    optional
                    id="cpfFamilyMax"
                    label="Most I would give (optional)"
                    prefix="S$"
                    placeholder="Up to the cap"
                    value={ui.cpfFamilyMax}
                    max={MAX_AMOUNT}
                    maxNote={MAX_AMOUNT_NOTE}
                    onChange={(cpfFamilyMax) => update({ cpfFamilyMax })}
                    // The matched amounts are worded once, by the engine (the same line is in the checklist
                    // under "Before you transfer"), so the form and the checklist cannot drift apart.
                    hint={familyHint ? <span data-testid="family-hint">{familyHint}</span> : undefined}
                  />
                ) : null}
              </CheckField>
            ) : null}
          </div>
          {/* Why a foreigner has no CPF option is said once on the page, in the engine's words: the line under
              the lock-up facts ("Before you transfer"), where the missing columns would otherwise be. */}
        </fieldset>

        <SegmentedField<Depth>
          name="depth"
          legend="How far down the ladder?"
          columns={2}
          value={ui.depth}
          options={DEPTHS.map((d) => ({ value: d, label: depthLabel(d, ui.residency) }))}
          // Opening "Custom" picks no rate: until the person picks one from the list below, a custom minimum
          // is the default for their residency (customRateOf), never a figure left from another residency.
          onChange={(depth) => update({ depth })}
          hint={<span data-testid="depth-hint">{depthExplanation(ui.depth, result)}</span>}
        />
        {foreigner ? (
          <p class="field-hint" data-testid="depth-foreigner-note">
            {foreignerDepthNote(rules)}
          </p>
        ) : null}
        {ui.depth === 'custom' ? (
          <SelectField
            id="customRate"
            label="Smallest saving per dollar"
            value={String(customRate)}
            options={customRateOptions(rules, baseline.marginalRate, customRate).map((rate) => ({
              value: String(rate),
              label: `${centsPerDollar(rate)} or more`,
            }))}
            onChange={(v) => update({ customRate: Number(v) })}
            hint={`Dollars taxed in the ${pct(customRate)} bracket and above go into the plan. The choices are the tax rates at or below your current one.`}
          />
        ) : null}

        {severalSchemes ? (
          <>
            <RadioList<Order>
              name="order"
              legend="Which first?"
              value={ui.order}
              options={(['flexibility', 'interest', 'family'] as Order[]).map((o) => ({
                value: o,
                title: ORDER_LABEL[o].title,
                detail: ORDER_LABEL[o].route,
                // The reasons are the lock-up facts themselves, so they cannot drift from "Before you transfer".
                note: orderWhy(o, facts).map((why, i) => (
                  <span key={why.term}>
                    {i > 0 ? ' ' : ''}
                    {why.term ? <b class="term">{why.term}: </b> : null}
                    {why.text}
                  </span>
                )),
              }))}
              onChange={(order) => update({ order })}
            />
            <p class="field-hint">
              The order does not change the tax you save. It only decides which scheme fills up first.
            </p>
          </>
        ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Itemised relief helper
// ---------------------------------------------------------------------------

const GROUP_TITLE: Record<ReliefCatalogItem['group'], string> = {
  family: 'Family',
  ns: 'National Service',
  other: 'Other',
  disability: 'Disability reliefs',
};

interface ReliefHelperProps {
  catalog: ReliefCatalogItem[];
  values: Record<string, number>;
  /** The total the engine used. */
  total: number;
  onChange: (id: string, value: number) => void;
  /**
   * Set while the helper is open on the untouched example: the example's total, which is still the figure in
   * use because nothing has been itemised. null once the person has entered something.
   */
  exampleTotal: number | null;
  /** "Example value", when the total should carry that tag. */
  flag: string | null;
  /** The person has none of these reliefs: count S$0 instead of the example's total. */
  onNone: () => void;
}

function ReliefHelper({ catalog, values, total, onChange, exampleTotal, flag, onNone }: ReliefHelperProps): JSX.Element {
  const group = (g: ReliefCatalogItem['group']): ReliefCatalogItem[] => catalog.filter((item) => item.group === g);
  const renderItems = (items: ReliefCatalogItem[]): JSX.Element[] =>
    items.map((item) => <ReliefItem key={item.id} item={item} value={values[item.id] ?? 0} onChange={onChange} />);
  const open = (['family', 'ns', 'other'] as const).filter((g) => group(g).length > 0);
  const disability = group('disability');

  return (
    <div class="helper">
      <p class="field-hint">
        The helper only adds up amounts. It does not check whether you qualify, so pick the reliefs you already
        claim or know you can.
      </p>
      {/* Said at the top, where the person lands after choosing Itemise: the list is empty, the example is not. */}
      {exampleTotal !== null ? (
        <div class="field-note field-note-action" data-testid="relief-example-note">
          <p>
            Nothing is itemised yet, so the example's {dollars(exampleTotal)} is still counted. It goes as soon as
            you enter a relief below.
          </p>
          <button type="button" class="btn btn-small" data-testid="relief-none" onClick={onNone}>
            I have none of these
          </button>
        </div>
      ) : null}
      {open.map((g) => (
        <div class="helper-group" key={g}>
          <h4 class="helper-title">{GROUP_TITLE[g]}</h4>
          {renderItems(group(g))}
        </div>
      ))}
      {disability.length > 0 ? (
        <details class="more">
          <summary>{GROUP_TITLE.disability}</summary>
          <div class="more-body">{renderItems(disability)}</div>
        </details>
      ) : null}
      <p class="aside-figure aside-total">
        <span>
          Other reliefs in total
          {flag ? (
            <span class="tag tag-example tag-after" data-testid="relief-total-flag">
              {flag}
            </span>
          ) : null}
        </span>
        <strong data-testid="relief-total">{dollars(total)}</strong>
      </p>
    </div>
  );
}

function ReliefItem(props: {
  item: ReliefCatalogItem;
  value: number;
  onChange: (id: string, value: number) => void;
}): JSX.Element {
  const { item, value, onChange } = props;
  const id = `relief-${item.id}`;
  const amount = reliefItemAmount(item, value);

  if (item.input === 'toggle') {
    return (
      <CheckField
        id={id}
        label={`${item.label}, ${dollars(item.amountPerUnit)}`}
        checked={value > 0}
        onChange={(on) => onChange(item.id, on ? 1 : 0)}
        detail={item.help}
      />
    );
  }
  if (item.input === 'count') {
    const max = item.max ?? 10;
    return (
      <SelectField
        id={id}
        label={`${item.label}, ${dollars(item.amountPerUnit)} each`}
        value={Math.min(value, max)}
        options={Array.from({ length: max + 1 }, (_, n) => ({
          value: n,
          label: n === 0 ? 'None' : `${n}, ${dollars(reliefItemAmount(item, n))}`,
        }))}
        onChange={(v) => onChange(item.id, Number(v))}
        hint={item.help}
      />
    );
  }
  if (item.input === 'select') {
    // A list, not a drop-down: these options are whole phrases ("Key appointment holder, no activities"),
    // and a closed drop-down would cut the chosen one short.
    const options = item.options ?? [];
    return (
      <RadioList<string>
        compact
        name={id}
        legend={item.label}
        value={String(Math.min(value, Math.max(0, options.length - 1)))}
        options={options.map((o, i) => ({ value: String(i), title: o.label }))}
        onChange={(v) => onChange(item.id, Number(v))}
        hint={item.help}
      />
    );
  }
  return (
    <NumberField
      id={id}
      label={item.label}
      prefix="S$"
      value={amount}
      max={item.max}
      maxNote={item.max !== undefined ? `${item.label} is limited to ${dollars(item.max)} here.` : undefined}
      onChange={(v) => onChange(item.id, v)}
      hint={item.help}
    />
  );
}
