import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { Plan, Step } from '../agent/types.js';
import { getTool } from '../agent/index.js';
import { planReviewStyles } from './plan-review.styles.js';

export type StepStatus = 'pending' | 'running' | 'success' | 'retry' | 'fail';
export type PlanReviewMode = 'plan' | 'running';

@customElement('plan-review')
export class PlanReview extends LitElement {
  static override styles = planReviewStyles;

  @property({ attribute: false }) plan?: Plan;
  @property({ attribute: false }) stepStatus: Map<string, StepStatus> = new Map();
  @property({ attribute: false }) stepDurations: Map<string, number> = new Map();
  @property({ attribute: false }) criticPatches: Map<string, Step> = new Map();
  @property({ type: String }) mode: PlanReviewMode = 'plan';

  @state() private _editingStepId: string | null = null;
  @state() private _editArgs: Record<string, unknown> = {};
  @state() private _editValid = false;

  override render() {
    if (!this.plan) return nothing;
    return html`
      <article class="glass">
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

        <div class="steps">
          ${this.plan.steps.map((s, i) => this._renderStep(s, i + 1))}
        </div>

        ${this.mode === 'plan' ? html`
          <footer class="foot">
            <button class="btn ghost reject" @click=${this._onReject}>↺ Reject &amp; rephrase</button>
            <div style="display:flex; gap: 8px;">
              <button class="btn run" @click=${this._onApprove}>Approve &amp; run →</button>
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
    return html`
      <article class="step">
        <div class="orb ${orbClass}">${this._orbContent(status, n)}</div>
        <div>
          <div class="tool">${s.tool}</div>
          <div class="why">${s.why}</div>
          ${isEditing ? this._renderEditingArgs(s) : this._renderArgs(s)}
          ${s.output_var ? html`<div class="out">→ <b>${s.output_var}</b></div>` : nothing}
          ${duration !== undefined ? html`<div class="out"><span class="chip">${duration} ms</span></div>` : nothing}
          ${patch ? html`<div class="critic">Critic patched: ${patch.why}</div>` : nothing}
        </div>
        <div class="step-actions">
          ${this.mode === 'plan' && !isEditing ? html`
            <button class="iconbtn" @click=${() => this._enterEdit(s)}>edit</button>
            <button class="iconbtn">why?</button>` : nothing}
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
    const shape = (t.args as any)?._def?.shape?.() ?? {};
    return html`
      <div class="args">
        ${Object.entries(shape).map(([k, schema]: any) => html`
          <div class="row">
            <span class="k">${k}</span>
            <span class="v">
              ${this._renderEditInput(step.tool, k, schema)}
            </span>
          </div>
        `)}
      </div>
      <div style="margin-top:8px; display:flex; gap:8px;">
        <button class="btn save" ?disabled=${!this._editValid} @click=${() => this._saveEdit(step)}>save</button>
        <button class="btn ghost" @click=${this._exitEdit}>cancel</button>
      </div>
    `;
  }

  private _renderEditInput(toolId: string, key: string, schema: any) {
    // Detect z.enum via _def.values
    const enumValues = schema?._def?.values;
    if (Array.isArray(enumValues)) {
      return html`<select name=${key} @input=${(e: Event) => this._onEditInput(toolId, key, e)}>
        ${enumValues.map((v: string) => html`<option value=${v} ?selected=${this._editArgs[key] === v}>${v}</option>`)}
      </select>`;
    }
    const isNumber = schema?._def?.typeName === 'ZodNumber';
    return html`<input name=${key}
      .value=${String(this._editArgs[key] ?? '')}
      @input=${(e: Event) => this._onEditInput(toolId, key, e)}
      type=${isNumber ? 'number' : 'text'} />`;
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
