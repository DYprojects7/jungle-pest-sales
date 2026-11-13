import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { dollars, isBlank, parseAmount, plain } from '../format';

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
 * A text input for whole numbers. Accepts digits and commas, shows the formatted value when not being
 * edited, selects everything on focus, and holds the value inside [min, max] with a plain explanation.
 * Empty is 0 (or "no limit" for optional fields). It never shows NaN.
 */
export function NumberField(props: NumberFieldProps): JSX.Element {
  const { id, label, prefix, suffix, min, max, hint, placeholder, caution, testid } = props;
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const lastSent = useRef<number | null>(props.value);

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
    if (value === props.value) return;
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
      n = min;
      if (final) why = props.minNote ?? `The least you can enter here is ${show(min)}.`;
    }
    setNote(why);
    send(n);
  };

  const shown = draft ?? (props.value === null ? '' : plain(props.value));
  const describedBy = [hint ? `${id}-hint` : '', note ? `${id}-note` : '', caution ? `${id}-caution` : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div class="field">
      <label class="field-label" for={id}>
        {label}
      </label>
      <div class="input-wrap">
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
          onFocus={(e) => {
            const el = e.currentTarget;
            setDraft(el.value);
            requestAnimationFrame(() => {
              if (document.activeElement === el) el.select();
            });
          }}
          onInput={(e) => {
            const el = e.currentTarget;
            const cleaned = el.value.replace(/[^\d,.]/g, '');
            if (cleaned !== el.value) el.value = cleaned;
            setDraft(cleaned);
            commit(cleaned, false);
          }}
          onBlur={(e) => {
            commit(e.currentTarget.value, true);
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
  hint?: ComponentChildren;
  hideLegend?: boolean;
  small?: boolean;
}

export function SegmentedField<T extends string | number>(props: SegmentedProps<T>): JSX.Element {
  const { name, legend, value, options, onChange, columns, hint, hideLegend, small } = props;
  return (
    <fieldset class="field seg-field">
      <legend class={hideLegend ? 'sr-only' : 'field-label'}>{legend}</legend>
      <div
        class={`seg${small ? ' seg-small' : ''}`}
        style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}
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
  options: { value: T; title: string; detail: string; note?: string }[];
  onChange: (value: T) => void;
}

export function RadioList<T extends string>(props: RadioListProps<T>): JSX.Element {
  const { name, legend, value, options, onChange } = props;
  return (
    <fieldset class="field">
      <legend class="field-label">{legend}</legend>
      <div class="radio-list">
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
                aria-describedby={`${id}-detail`}
                onChange={() => onChange(o.value)}
              />
              <div class="check-body">
                <label class="check-label" for={id}>
                  {o.title} <span class="check-route">{o.detail}</span>
                </label>
                <p class="field-hint" id={`${id}-detail`}>
                  {o.note}
                </p>
              </div>
            </div>
          );
        })}
      </div>
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

/** A table that scrolls sideways inside its own box instead of pushing the page wider. */
export function TableScroll(props: { label: string; children: ComponentChildren }): JSX.Element {
  return (
    <div class="table-scroll" role="region" aria-label={props.label} tabIndex={0}>
      {props.children}
    </div>
  );
}
