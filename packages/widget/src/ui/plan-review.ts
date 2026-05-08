import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { z } from 'zod';
import type { Plan, Step } from '../agent/types.js';
import { getTool } from '../agent/index.js';
import { planReviewStyles } from './plan-review.styles.js';

/**
 * Best-effort extraction of the per-key Zod schema map for an object
 * schema. Uses Zod's public `shape` accessor; returns null for non-object
 * schemas (which the edit form cannot render anyway). Keeps the brittle
 * `_def.shape()` private-API access out of the component code.
 */
function getZodObjectShape(
  schema: z.ZodTypeAny,
): Record<string, z.ZodTypeAny> | null {
  if (schema instanceof z.ZodObject) {
    return schema.shape as Record<string, z.ZodTypeAny>;
  }
  return null;
}

/**
 * Pull the literal values out of a `z.enum([...])` schema. Returns null
 * if the schema is not a ZodEnum (after stripping wrappers).
 */
function getZodEnumValues(schema: z.ZodTypeAny): readonly string[] | null {
  const inner = unwrapZod(schema);
  if (inner instanceof z.ZodEnum) {
    return inner.options as readonly string[];
  }
  return null;
}

/**
 * Peel off `.optional()` / `.default(...)` / `.nullable()` wrappers so
 * downstream `instanceof` checks see the actual primitive schema. Many
 * tool args use these wrappers (e.g. `Units.default('meters')`); without
 * unwrapping, the inline editor falls back to a free-text input instead
 * of a select / number-spinner.
 */
function unwrapZod(schema: z.ZodTypeAny): z.ZodTypeAny {
  let s: z.ZodTypeAny = schema;
  // Bounded loop: handles e.g. `.optional().default(...)` chains without
  // any chance of infinite recursion if a future Zod version adds new
  // wrappers we don't unwrap.
  for (let i = 0; i < 4; i++) {
    if (s instanceof z.ZodOptional || s instanceof z.ZodNullable) {
      s = s.unwrap();
      continue;
    }
    if (s instanceof z.ZodDefault) {
      s = s.removeDefault();
      continue;
    }
    break;
  }
  return s;
}

export type StepStatus = 'pending' | 'running' | 'success' | 'retry' | 'fail';
export type PlanReviewMode = 'plan' | 'running';

@customElement('plan-review')
export class PlanReview extends LitElement {
  static override styles = planReviewStyles;

  @property({ attribute: false }) plan?: Plan;
  @property({ attribute: false }) stepStatus: Map<string, StepStatus> = new Map();
  @property({ attribute: false }) stepDurations: Map<string, number> = new Map();
  @property({ attribute: false }) criticPatches: Map<string, Step> = new Map();
  @property({ attribute: false }) criticAttempts: Map<string, Array<{
    attempt: number;
    maxAttempts: number;
    decision: 'patch' | 'retry' | 'abort';
    errorMessage: string;
  }>> = new Map();
  @property({ type: String }) mode: PlanReviewMode = 'plan';

  @state() private _editingStepId: string | null = null;
  @state() private _editArgs: Record<string, unknown> = {};
  @state() private _editValid = false;

  override render() {
    if (!this.plan) return nothing;
    return html`
      <article class="glass" role="region" aria-label="Agent plan review">
        <header class="head">
          <h2 class="title">${this.plan.goal}</h2>
          <div class="meta">
            <span class="chip accent">${this.plan.steps.length} steps</span>
            ${this.plan.dataset_refs.map((d) => html`<span class="chip">${d}</span>`)}
          </div>
        </header>
        ${this.plan.assumptions.length ? html`
          <div class="assumptions">
            <span style="font-weight:600; min-width: 88px;">Assumes</span>
            <ul>${this.plan.assumptions.map((a) => html`<li>${a}</li>`)}</ul>
          </div>` : nothing}

        <div class="steps" role="list" aria-label="Plan steps">
          ${this.plan.steps.map((s, i) => this._renderStep(s, i + 1))}
        </div>

        ${this.mode === 'plan' ? html`
          <footer class="foot">
            <button
              class="btn ghost reject"
              type="button"
              aria-label="Reject this plan and ask the agent to rephrase"
              @click=${this._onReject}
            >↺ Reject &amp; rephrase</button>
            <div style="display:flex; gap: 8px;">
              <button
                class="btn run"
                type="button"
                aria-label="Approve this plan and run all steps"
                @click=${this._onApprove}
              >Approve &amp; run →</button>
            </div>
          </footer>` : nothing}
      </article>
    `;
  }

  private _renderStep(s: Step, n: number) {
    const status = this.stepStatus.get(s.id) ?? 'pending';
    const duration = this.stepDurations.get(s.id);
    const patch = this.criticPatches.get(s.id);
    const orbClass = status === 'pending' ? '' : status;
    const isEditing = this._editingStepId === s.id;
    const stepLabel = `Step ${n}: ${s.tool}`;
    return html`
      <article class="step" role="listitem" aria-label=${stepLabel}>
        <div class="orb ${orbClass}" aria-hidden="true">${this._orbContent(status, n)}</div>
        <div>
          <div class="tool">${s.tool}</div>
          <div class="why">${s.why}</div>
          ${isEditing ? this._renderEditingArgs(s) : this._renderArgs(s)}
          ${s.output_var ? html`<div class="out">→ <b>${s.output_var}</b></div>` : nothing}
          ${duration !== undefined ? html`<div class="out"><span class="chip">${duration} ms</span></div>` : nothing}
          ${patch ? html`<div class="critic">Critic patched: ${patch.why}</div>` : nothing}
          ${this._renderAttempts(s.id)}
        </div>
        <div class="step-actions">
          ${this.mode === 'plan' && !isEditing ? html`
            <button
              class="iconbtn"
              type="button"
              aria-label="Edit step ${n} (${s.tool})"
              title=${`Edit ${s.tool}`}
              @click=${() => this._enterEdit(s)}
            >edit</button>` : nothing}
        </div>
      </article>
    `;
  }

  private _enterEdit(step: Step) {
    this._editingStepId = step.id;
    this._editArgs = { ...step.args };
    this._validateEdit(step.tool);
  }

  private _exitEdit = () => {
    this._editingStepId = null;
    this._editArgs = {};
    this._editValid = false;
  };

  private _validateEdit(toolId: string) {
    const t = getTool(toolId);
    if (!t) { this._editValid = false; return; }
    this._editValid = t.args.safeParse(this._editArgs).success;
  }

  private _onEditInput(toolId: string, key: string, ev: Event) {
    const target = ev.target as HTMLInputElement | HTMLSelectElement;
    const raw = target.value;
    // Coerce numbers when the input is type=number (HTMLInputElement only).
    let coerced: unknown = raw;
    if (target instanceof HTMLInputElement && target.type === 'number') {
      coerced = raw === '' ? '' : Number(raw);
    }
    this._editArgs = { ...this._editArgs, [key]: coerced };
    this._validateEdit(toolId);
  }

  private _saveEdit(step: Step) {
    if (!this._editValid) return;
    this.dispatchEvent(new CustomEvent('step:edit', {
      detail: { stepId: step.id, args: this._editArgs },
    }));
    this._exitEdit();
  }

  private _renderEditingArgs(step: Step) {
    const t = getTool(step.tool);
    if (!t) return nothing;
    const shape = getZodObjectShape(t.args);
    if (!shape) return nothing;
    return html`
      <div class="args" role="group" aria-label="Edit step arguments">
        ${Object.entries(shape).map(([k, schema]) => html`
          <div class="row">
            <label class="k" for=${`edit-${step.id}-${k}`}>${k}</label>
            <span class="v">
              ${this._renderEditInput(step.tool, step.id, k, schema)}
            </span>
          </div>
        `)}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button
          class="btn save"
          type="button"
          ?disabled=${!this._editValid}
          aria-label="Save edits to this step"
          @click=${() => this._saveEdit(step)}
        >save</button>
        <button
          class="btn ghost"
          type="button"
          aria-label="Cancel editing this step"
          @click=${this._exitEdit}
        >cancel</button>
      </div>
    `;
  }

  private _renderEditInput(
    toolId: string,
    stepId: string,
    key: string,
    schema: z.ZodTypeAny,
  ) {
    const inputId = `edit-${stepId}-${key}`;
    const enumValues = getZodEnumValues(schema);
    if (enumValues) {
      return html`<select
        id=${inputId}
        name=${key}
        @input=${(e: Event) => this._onEditInput(toolId, key, e)}
      >
        ${enumValues.map((v) => html`<option value=${v} ?selected=${this._editArgs[key] === v}>${v}</option>`)}
      </select>`;
    }
    const isNumber = unwrapZod(schema) instanceof z.ZodNumber;
    return html`<input
      id=${inputId}
      name=${key}
      .value=${String(this._editArgs[key] ?? '')}
      @input=${(e: Event) => this._onEditInput(toolId, key, e)}
      type=${isNumber ? 'number' : 'text'}
    />`;
  }

  private _orbContent(status: StepStatus, n: number) {
    if (status === 'success') return html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 8.5L7 12l6-7"/></svg>`;
    if (status === 'running') return html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M14 8a6 6 0 1 1-3-5.2"/></svg>`;
    if (status === 'retry')   return html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 1.5L1 14h14L8 1.5z"/><path d="M8 6v4M8 11.6v.1"/></svg>`;
    if (status === 'fail')    return html`<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M3 3l10 10M13 3L3 13"/></svg>`;
    return String(n);
  }

  private _renderArgs(s: Step) {
    const entries = Object.entries(s.args ?? {});
    if (entries.length === 0) return nothing;
    return html`<div class="args">${entries.map(([k, v]) => html`
      <div class="row"><span class="k">${k}</span><span class="v">${this._renderArgValue(v)}</span></div>
    `)}</div>`;
  }

  private _renderAttempts(stepId: string) {
    const log = this.criticAttempts.get(stepId);
    if (!log || log.length === 0) return nothing;
    return html`
      <div class="critic-timeline" aria-label="Critic attempt log">
        ${log.map((a) => html`
          <div class="attempt-badge ${a.decision}">
            attempt ${a.attempt} of ${a.maxAttempts} — ${a.decision}
            <div class="attempt-error">${a.errorMessage}</div>
          </div>
        `)}
      </div>
    `;
  }

  private _renderArgValue(v: unknown): unknown {
    if (typeof v === 'string') {
      if (v.startsWith('${') && v.endsWith('}')) return html`<span class="var">${v}</span>`;
      return html`<span class="str">"${v}"</span>`;
    }
    if (typeof v === 'number') return html`<span class="num">${v}</span>`;
    if (typeof v === 'boolean') return String(v);
    return JSON.stringify(v);
  }

  private _onApprove = () => {
    if (!this.plan) return;
    this.dispatchEvent(new CustomEvent('plan:approve', { detail: { plan: this.plan } }));
  };
  private _onReject = () => {
    this.dispatchEvent(new CustomEvent('plan:reject', { detail: { plan: this.plan } }));
  };
}

declare global {
  interface HTMLElementTagNameMap {
    'plan-review': PlanReview;
  }
}
