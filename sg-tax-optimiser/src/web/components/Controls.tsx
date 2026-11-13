import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { cleanAmountText, dollars, isBlank, parseAmount, plain } from '../format';
import { useElementWidth, useScrollEdges } from '../hooks';

// ---------------------------------------------------------------------------
// Number field: money and other whole numbers
// ---------------------------------------------------------------------------

interface NumberFieldBase {
  id: string;
  label: ComponentChildren;
  /** Shown before the value, e.g. "S$". */
  prefix?: string;
  /** Shown after the value, e.g. "years". */
  suffix?: string;
  min?: number;
  max?: number;
  /** Why the value was held at `max`, e.g. "SRS is capped at S$15,300 a year." */
  maxNote?: string;
  /** Why the value was raised to `min`. */
  minNote?: string;
  hint?: ComponentChildren;
  placeholder?: string;
  /** A caution about this field from the engine (shown under the field). */
  caution?: string | null;
  /** A short tag beside the label, e.g. "Example value" while the field still holds the example's figure. */
  flag?: string | null;
  testid?: string;
}

interface RequiredNumberField extends NumberFieldBase {
  optional?: false;
  value: number;
  onChange: (value: number) => void;
}

interface OptionalNumberField extends NumberFieldBase {
  /** Empty means "no limit" (null) instead of 0. */
  optional: true;
  value: number | null;
  onChange: (value: number | null) => void;
}

export type NumberFieldProps = RequiredNumberField | OptionalNumberField;

/**
 * A text input for whole numbers. Accepts digits and commas (and full-width digits, and "12k" in money
 * fields), shows the formatted value when not being edited, selects everything on focus, and holds the value
 * inside [min, max] with a plain explanation. Empty is 0 (or "not given" for optional fields). It never shows
 * NaN.
 *
 * Three rules keep it from changing the result behind the person's back:
 * - a value below `min` is only corrected when they leave the field, so typing "55" does not pass through
 *   "5" and get raised to the minimum on the way;
 * - leaving the field without typing changes nothing, even if the value on show is outside the range;
 * - when letters or a minus sign were typed and left out, the field says what it read.
 *
 * Whatever is typed is passed on, even when it equals the value already there: retyping the example's figure
 * is how somebody says "this one is right for me too".
 */
export function NumberField(props: NumberFieldProps): JSX.Element {
  const { id, label, prefix, suffix, min, max, hint, placeholder, caution, flag, testid } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lastSent = useRef<number | null>(props.value);
  const selectOnRelease = useRef(false);
  /** True once the person has typed since the field took focus. */
  const typed = useRef(false);
  /** True when something other than digits was typed and left out during this visit to the field. */
  const dropped = useRef(false);

  // A change from outside (Reset, loading saved numbers) clears any leftover explanation.
  useEffect(() => {
    if (props.value !== lastSent.current) {
      lastSent.current = props.value;
      setNote(null);
    }
  }, [props.value]);

  const money = prefix === 'S$';
  const show = (n: number): string => (money ? dollars(n) : plain(n));

  const send = (value: number | null): void => {
    lastSent.current = value;
    if (props.optional) props.onChange(value);
    else props.onChange(value ?? 0);
  };

  /** Read the text, hold it in range and pass it on. `final` is true when the person leaves the field. */
  const commit = (text: string, final: boolean): void => {
    if (props.optional && isBlank(text)) {
      setNote(null);
      send(null);
      return;
    }
    let n = parseAmount(text);
    let why: string | null = null;
    if (max !== undefined && n > max) {
      n = max;
      why = props.maxNote ?? `The most you can enter here is ${show(max)}.`;
    }
    if (min !== undefined && n < min) {
      // Still typing, or left empty: keep the last value that was in range.
      if (!final || isBlank(text)) {
        setNote(null);
        return;
      }
      n = min;
      why = props.minNote ?? `The least you can enter here is ${show(min)}.`;
    }
    if (why === null && dropped.current) why = `Only digits are read here, so this counts as ${show(n)}.`;
    setNote(why);
    send(n);
  };

  /** Keep what can be read of the typed text, show it, and pass the value on. */
  const take = (el: HTMLInputElement): void => {
    const cleaned = cleanAmountText(el.value, money);
    if (cleaned.text !== el.value) el.value = cleaned.text;
    // Stays set for the rest of this visit to the field, until the field is emptied.
    dropped.current = cleaned.dropped || (dropped.current && !isBlank(cleaned.text));
    typed.current = true;
    setDraft(cleaned.text);
    commit(cleaned.text, false);
  };

  const shown = draft ?? (props.value === null ? '' : plain(props.value));
  const describedBy = [hint ? `${id}-hint` : '', note ? `${id}-note` : '', caution ? `${id}-caution` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div class="field">
      <div class="field-head">
        <label class="field-label" for={id}>
          {label}
        </label>
        {flag ? (
          <span class="tag tag-example" data-testid={`${id}-flag`}>
            {flag}
          </span>
        ) : null}
      </div>
      <div class={`input-wrap${suffix ? ' has-suffix' : ''}`}>
        {prefix ? (
          <span class="affix affix-pre" aria-hidden="true">
            {prefix}
          </span>
        ) : null}
        <input
          id={id}
          class="input input-num"
          type="text"
          inputMode="numeric"
          autocomplete="off"
          spellcheck={false}
          placeholder={placeholder}
          value={shown}
          data-testid={testid}
          aria-describedby={describedBy || undefined}
          onMouseDown={(e) => {
            // A click that brings focus should leave everything selected, not drop a caret into the number.
            selectOnRelease.current = document.activeElement !== e.currentTarget;
          }}
          onFocus={(e) => {
            typed.current = false;
            dropped.current = false;
            setDraft(e.currentTarget.value);
            e.currentTarget.select();
          }}
          onMouseUp={(e) => {
            if (!selectOnRelease.current) return;
            selectOnRelease.current = false;
            e.preventDefault();
            e.currentTarget.select();
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            // While an input method is composing (full-width digits, for one), the text is not ours to rewrite:
            // it is read when the composition ends.
            if ((e as unknown as { isComposing?: boolean }).isComposing) {
              typed.current = true;
              setDraft(el.value);
              return;
            }
            take(el);
          }}
          onCompositionEnd={(e) => take(e.currentTarget)}
          onBlur={(e) => {
            selectOnRelease.current = false;
            if (typed.current) commit(e.currentTarget.value, true);
            typed.current = false;
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        {suffix ? (
          <span class="affix affix-post" aria-hidden="true">
            {suffix}
          </span>
        ) : null}
      </div>
      {hint ? (
        <p class="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {note ? (
        <p class="field-note" id={`${id}-note`} role="status">
          {note}
        </p>
      ) : null}
      {caution ? (
        <p class="field-note" id={`${id}-caution`}>
          {caution}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Segmented control (a radio group)
// ---------------------------------------------------------------------------

interface SegmentedProps<T extends string | number> {
  /** Used as the radio group name and the id prefix: ids are `${name}-${value}`. */
  name: string;
  legend: ComponentChildren;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  /** Lay the options out in this many columns (default: one row). */
  columns?: number;
  /** Column widths when the options should not be equal, e.g. "1fr 1fr 1.7fr". Overrides `columns`. */
  template?: string;
  hint?: ComponentChildren;
  hideLegend?: boolean;
  small?: boolean;
}

export function SegmentedField<T extends string | number>(props: SegmentedProps<T>): JSX.Element {
  const { name, legend, value, options, onChange, columns, template, hint, hideLegend, small } = props;
  return (
    <fieldset class={`field seg-field${small ? ' seg-field-small' : ''}`}>
      <legend class={hideLegend ? 'sr-only' : 'field-label'}>{legend}</legend>
      <div
        class={`seg${small ? ' seg-small' : ''}`}
        style={{ gridTemplateColumns: template ?? `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
      >
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <label class="seg-opt" for={id} key={id}>
              <input
                type="radio"
                id={id}
                name={name}
                value={String(o.value)}
                checked={o.value === value}
                onChange={() => onChange(o.value)}
              />
              <span>{o.label}</span>
            </label>
          );
        })}
      </div>
      {hint ? <p class="field-hint">{hint}</p> : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------

interface SelectFieldProps {
  id: string;
  label: ComponentChildren;
  value: string | number;
  options: { value: string | number; label: string }[];
  onChange: (value: string) => void;
  hint?: ComponentChildren;
  inline?: boolean;
}

export function SelectField(props: SelectFieldProps): JSX.Element {
  const { id, label, value, options, onChange, hint, inline } = props;
  return (
    <div class={`field${inline ? ' field-inline' : ''}`}>
      <label class="field-label" for={id}>
        {label}
      </label>
      <div class="select-wrap">
        <select
          id={id}
          class="input select"
          value={String(value)}
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {options.map((o) => (
            <option value={String(o.value)} key={String(o.value)}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      {hint ? (
        <p class="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkbox
// ---------------------------------------------------------------------------

interface CheckFieldProps {
  id: string;
  label: ComponentChildren;
  checked: boolean;
  onChange: (checked: boolean) => void;
  detail?: ComponentChildren;
  disabled?: boolean;
  children?: ComponentChildren;
}

export function CheckField(props: CheckFieldProps): JSX.Element {
  const { id, label, checked, onChange, detail, disabled, children } = props;
  return (
    <div class="check">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-describedby={detail ? `${id}-detail` : undefined}
        onChange={(e) => onChange(e.currentTarget.checked)}
      />
      <div class="check-body">
        <label class="check-label" for={id}>
          {label}
        </label>
        {detail ? (
          <p class="field-hint" id={`${id}-detail`}>
            {detail}
          </p>
        ) : null}
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Radio list with a description per option
// ---------------------------------------------------------------------------

interface RadioListProps<T extends string> {
  name: string;
  legend: ComponentChildren;
  value: T;
  options: { value: T; title: string; detail?: string; note?: string }[];
  onChange: (value: T) => void;
  /** Options without notes sit closer together. */
  compact?: boolean;
  hint?: ComponentChildren;
}

/**
 * One choice from a short list, each option on its own line. Used where the wording of an option is too long
 * for a drop-down to show in full once it is closed.
 */
export function RadioList<T extends string>(props: RadioListProps<T>): JSX.Element {
  const { name, legend, value, options, onChange, compact, hint } = props;
  return (
    <fieldset class="field">
      <legend class="field-label">{legend}</legend>
      <div class={`radio-list${compact ? ' radio-list-compact' : ''}`}>
        {options.map((o) => {
          const id = `${name}-${o.value}`;
          return (
            <div class="check" key={id}>
              <input
                type="radio"
                id={id}
                name={name}
                value={o.value}
                checked={o.value === value}
                aria-describedby={o.note ? `${id}-detail` : undefined}
                onChange={() => onChange(o.value)}
              />
              <div class="check-body">
                <label class="check-label" for={id}>
                  {o.title}
                  {o.detail ? (
                    <>
                      {' '}
                      <span class="check-route">{o.detail}</span>
                    </>
                  ) : null}
                </label>
                {o.note ? (
                  <p class="field-hint" id={`${id}-detail`}>
                    {o.note}
                  </p>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {hint ? <p class="field-hint">{hint}</p> : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

/** A label ... amount row, the way a payslip or tax notice sets them. */
export function Row(props: {
  label: ComponentChildren;
  value: ComponentChildren;
  total?: boolean;
  strong?: boolean;
  testid?: string;
}): JSX.Element {
  return (
    <div class={`row${props.total ? ' row-total' : ''}${props.strong ? ' row-strong' : ''}`}>
      <dt>{props.label}</dt>
      <dd data-testid={props.testid}>{props.value}</dd>
    </div>
  );
}

/**
 * A table that scrolls sideways inside its own box instead of pushing the page wider.
 *
 * - While it scrolls, the box is a named, focusable region (so keyboard users can reach the hidden columns
 *   without tabbing through every table that already fits), the side with more to see is shaded, and a line
 *   under the table says it scrolls.
 * - With `stackBelow`, a box narrower than that many pixels restacks the table instead: each row becomes a
 *   block of label-and-value lines, so nothing is off screen on a phone. The styles read each cell's
 *   `data-label`.
 */
export function TableScroll(props: {
  label: string;
  /** Restack the table when its box is narrower than this many pixels. */
  stackBelow?: number;
  /** 'rows': one label and value per line. 'lines': the row heading and its total on one line, the rest below. */
  stack?: 'rows' | 'lines';
  children: ComponentChildren;
}): JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(wrapRef, 4000);
  const stacked = props.stackBelow !== undefined && width < props.stackBelow;
  const edges = useScrollEdges(ref);
  const scrolls = !stacked && (edges.left || edges.right);
  return (
    <div class="table-block">
      <div
        class="table-wrap"
        ref={wrapRef}
        data-more-left={scrolls && edges.left ? 'true' : undefined}
        data-more-right={scrolls && edges.right ? 'true' : undefined}
      >
        <div
          class="table-scroll"
          ref={ref}
          data-stacked={stacked ? (props.stack ?? 'rows') : undefined}
          role={scrolls ? 'region' : undefined}
          aria-label={scrolls ? props.label : undefined}
          tabIndex={scrolls ? 0 : undefined}
        >
          {props.children}
        </div>
      </div>
      {scrolls ? (
        <p class="scroll-hint" aria-hidden="true" data-testid="scroll-hint">
          Scroll sideways to see every column
        </p>
      ) : null}
    </div>
  );
}
