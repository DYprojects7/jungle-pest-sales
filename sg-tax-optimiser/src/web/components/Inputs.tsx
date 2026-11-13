import type { JSX } from 'preact';
import { SUPPORTED_INCOME_YEARS, getRules } from '../../engine';
import type { PlannerResult, PrYear, ReliefCatalogItem, Residency } from '../../engine/types';
import { centsPerDollar, dayAndMonth, dollars, monthName, pct } from '../format';
import type { Depth, Order, PayMode, ReliefMode, UiState } from '../state';
import { customRateOptions, monthlyWage, reliefItemAmount } from '../state';
import { DEPTH_LABEL, ORDER_LABEL, depthExplanation } from '../text';
import { CheckField, NumberField, RadioList, SegmentedField, SelectField } from './Controls';

/** Largest amount a money field accepts. Far above any salary; it only keeps typos from running away. */
const MAX_AMOUNT = 100_000_000;
const MAX_AMOUNT_NOTE = `Enter an amount up to ${dollars(MAX_AMOUNT)}.`;

interface InputsProps {
  ui: UiState;
  result: PlannerResult;
  update: (patch: Partial<UiState>) => void;
}

export function Inputs({ ui, result, update }: InputsProps): JSX.Element {
  const { rules, levers, cpf, baseline } = result;
  const year = rules.incomeYear;
  const foreigner = ui.residency === 'foreigner';
  const crossesCpfBand = rules.cpf.fullRates.some((band) => band.maxAge === ui.age);
  const warning = (code: string): string | null => result.warnings.find((w) => w.code === code)?.message ?? null;

  const setPayMode = (mode: PayMode): void => {
    if (mode === ui.payMode) return;
    // Keep the same pay: an annual figure is twelve months' pay.
    update({ payMode: mode, salary: mode === 'annual' ? ui.salary * 12 : Math.floor(ui.salary / 12) });
  };

  const setItem = (id: string, value: number): void => {
    update({ reliefItems: { ...ui.reliefItems, [id]: value } });
  };

  const yearOptions = SUPPORTED_INCOME_YEARS.slice()
    .sort((a, b) => b - a)
    .map((y) => {
      const r = getRules(y);
      return { value: y, label: `${y} (YA${r.ya})${r.status === 'projected' ? ', projected' : ''}` };
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
          hint={
            foreigner
              ? 'A foreigner who is a Singapore tax resident for the year. Non-residents are taxed differently and are not covered.'
              : undefined
          }
        />
        {ui.residency === 'pr' ? (
          <SegmentedField<PrYear>
            name="prYear"
            legend="Years as a PR"
            value={ui.prYear}
            options={[
              { value: 1, label: '1st year' },
              { value: 2, label: '2nd year' },
              { value: 3, label: '3rd year on' },
            ]}
            onChange={(prYear) => update({ prYear })}
            hint="PRs pay lower CPF rates in their first two years. If you opted for full rates, choose 3rd year on."
          />
        ) : null}
        <div class="field-pair">
          <NumberField
            id="age"
            label={`Age on 31 Dec ${year}`}
            value={ui.age}
            min={15}
            max={100}
            minNote="Enter an age from 15 to 100."
            maxNote="Enter an age from 15 to 100."
            suffix="years"
            onChange={(age) => update({ age })}
          />
          {yearOptions.length > 1 ? (
            <SelectField
              id="incomeYear"
              label="Income year"
              value={ui.incomeYear}
              options={yearOptions}
              onChange={(v) => update({ incomeYear: Number(v) })}
            />
          ) : null}
        </div>
        {rules.status === 'projected' ? (
          <p class="field-note">
            Rules for {year} are projected from what has been announced so far. Treat the figures as provisional.
          </p>
        ) : null}
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
          label={ui.payMode === 'annual' ? 'Annual salary' : 'Monthly salary'}
          prefix="S$"
          value={ui.salary}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          onChange={(salary) => update({ salary })}
          hint={
            ui.payMode === 'annual'
              ? `Twelve months of basic pay and fixed allowances, before CPF. Treated as ${dollars(monthlyWage(ui))} a month.`
              : 'Basic pay and fixed allowances, before CPF.'
          }
        />
        <NumberField
          id="bonus"
          testid="bonus"
          label={`Bonus and other extra pay in ${year}`}
          prefix="S$"
          value={ui.bonus}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          onChange={(bonus) => update({ bonus })}
          hint="13th month, performance bonus, commissions."
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
        {!foreigner ? (
          <p class="aside-figure">
            <span>{cpf.source === 'override' ? 'Employee CPF used (your figure)' : 'Employee CPF for the year (estimated)'}</span>
            <strong data-testid="cpf-employee">{dollars(cpf.employeeContribution)}</strong>
          </p>
        ) : null}
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
              hint="Net rental income or taxable benefits, for example. No CPF is paid on it."
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
                    on && ui.cpfOverride === 0
                      ? { cpfOverrideOn: true, cpfOverride: cpf.employeeContribution }
                      : { cpfOverrideOn: on },
                  )
                }
                detail="From your payslips or CPF statement. Only the compulsory employee share counts."
              >
                {ui.cpfOverrideOn ? (
                  <NumberField
                    id="cpfOverride"
                    label="Employee CPF for the year"
                    prefix="S$"
                    value={ui.cpfOverride}
                    max={MAX_AMOUNT}
                    maxNote={MAX_AMOUNT_NOTE}
                    onChange={(cpfOverride) => update({ cpfOverride })}
                    caution={warning('CPF_OVERRIDE_ABOVE_MAX')}
                  />
                ) : null}
              </CheckField>
            ) : null}
          </div>
        </details>
      </section>

      {/* ------------------------------------------------------------------ */}
      <section class="group" aria-labelledby="g-existing">
        <h3 class="group-title" id="g-existing">
          Already contributed in {year}
        </h3>
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
            onChange={(reliefMode) => update({ reliefMode })}
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
            onChange={(reliefTotal) => update({ reliefTotal })}
            hint="Spouse, child, parent, NSman and similar reliefs. Leave out CPF, SRS and Earned Income Relief: those are worked out for you."
          />
        ) : (
          <ReliefHelper
            catalog={rules.reliefCatalog}
            values={ui.reliefItems}
            total={result.input.otherReliefs}
            onChange={setItem}
          />
        )}
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
                    label="Room left in your CPF accounts (optional)"
                    prefix="S$"
                    placeholder="Not sure"
                    value={ui.cpfSelfRoom}
                    max={MAX_AMOUNT}
                    maxNote={MAX_AMOUNT_NOTE}
                    onChange={(cpfSelfRoom) => update({ cpfSelfRoom })}
                    hint={`How much you can still top up before the Full Retirement Sum (${dollars(rules.cpfTopUp.fullRetirementSum)}) and the Basic Healthcare Sum (${dollars(rules.cpfTopUp.basicHealthcareSum)}). Leave empty if the limits are far off.`}
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
                  />
                ) : null}
              </CheckField>
            ) : null}
          </div>
          {foreigner ? (
            <p class="field-hint" data-testid="foreigner-note">
              CPF top-ups are not offered. Foreigners on work passes have no CPF account, and relief for topping up
              family members is only for Citizens and PRs.
            </p>
          ) : null}
        </fieldset>

        <SegmentedField<Depth>
          name="depth"
          legend="How far down the ladder?"
          columns={2}
          value={ui.depth}
          options={(['worth', 'top', 'every', 'custom'] as Depth[]).map((d) => ({ value: d, label: DEPTH_LABEL[d] }))}
          onChange={(depth) => update({ depth })}
          hint={depthExplanation(ui.depth, result)}
        />
        {ui.depth === 'custom' ? (
          <SelectField
            id="customRate"
            label="Smallest saving per dollar"
            value={String(ui.customRate)}
            options={customRateOptions(rules, baseline.marginalRate, ui.customRate).map((rate) => ({
              value: String(rate),
              label: `${centsPerDollar(rate)} or more (the ${pct(rate)} bracket and above)`,
            }))}
            onChange={(v) => update({ customRate: Number(v) })}
          />
        ) : null}

        <NumberField
          optional
          id="cashLimit"
          label="Cash limit (optional)"
          prefix="S$"
          placeholder="No limit"
          value={ui.cashLimit}
          max={MAX_AMOUNT}
          maxNote={MAX_AMOUNT_NOTE}
          onChange={(cashLimit) => update({ cashLimit })}
          hint={`The most you are willing to lock away before ${dayAndMonth(rules.contributionDeadline)}.`}
        />

        <RadioList<Order>
          name="order"
          legend="Which first?"
          value={ui.order}
          options={(['flexibility', 'interest', 'family'] as Order[]).map((o) => ({
            value: o,
            title: ORDER_LABEL[o].title,
            detail: ORDER_LABEL[o].route,
            note: ORDER_LABEL[o].why,
          }))}
          onChange={(order) => update({ order })}
        />
        <p class="field-hint">The order does not change the tax you save. It only decides which scheme fills up first.</p>
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
}

function ReliefHelper({ catalog, values, total, onChange }: ReliefHelperProps): JSX.Element {
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
        <span>Other reliefs in total</span>
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
    const options = item.options ?? [];
    return (
      <SelectField
        id={id}
        label={item.label}
        value={Math.min(value, Math.max(0, options.length - 1))}
        options={options.map((o, i) => ({ value: i, label: o.label }))}
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
