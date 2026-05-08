import { listTools } from '../tools/registry.js';
import type { ToolDef } from '../tools/types.js';
import templateRaw from './planner.system.md?raw';

export interface DatasetProfile {
  name: string;
  kind: 'table' | 'layer';
  rows: number;
  geometry?: {
    kind: 'point' | 'line' | 'polygon' | 'multi';
    column: string;
    crs?: string;
    bbox?: [number, number, number, number];
  };
  columns: Array<{ name: string; type: string; range?: [number | string, number | string]; nulls?: number; cardinality?: number }>;
  sample: unknown[];
}

const DATASET_CAP = 5;
const SAMPLE_CAP = 3;

export function renderDatasetsBlock(datasets: DatasetProfile[]): string {
  const lines: string[] = [];
  for (const d of datasets.slice(0, DATASET_CAP)) {
    lines.push(`## ${d.name} (${d.kind})`);
    lines.push(`- rows: ${d.rows}`);
    if (d.geometry) {
      const bbox = d.geometry.bbox ? ` bbox: [${d.geometry.bbox.join(', ')}]` : '';
      const crs = d.geometry.crs ? ` CRS: ${d.geometry.crs}` : '';
      lines.push(`- geometry: ${d.geometry.kind} (column: ${d.geometry.column},${crs}${bbox})`);
    }
    lines.push(`- columns:`);
    for (const c of d.columns) {
      const range = c.range ? ` (range: ${c.range[0]}-${c.range[1]})` : '';
      const nulls = c.nulls !== undefined ? ` nulls: ${c.nulls}` : '';
      const card = c.cardinality !== undefined ? ` cardinality: ${c.cardinality}` : '';
      lines.push(`  - ${c.name}: ${c.type}${range}${nulls}${card}`.trimEnd());
    }
    if (d.sample.length) {
      lines.push(`- sample rows (${Math.min(d.sample.length, SAMPLE_CAP)}): ${JSON.stringify(d.sample.slice(0, SAMPLE_CAP))}`);
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function renderToolsBlock(): string {
  const tools = listTools();
  const groups = new Map<string, ToolDef[]>();
  for (const t of tools) {
    const ns = t.id.includes('.') ? t.id.split('.')[0]! : t.id;
    const key = ns === 'sql' ? 'sql' : `${ns}.*`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }
  const order = ['geometry.*', 'joins.*', 'stats.*', 'render.*', 'sql'];
  const ordered = order.filter((k) => groups.has(k));

  const out: string[] = [];
  for (const ns of ordered) {
    out.push(`## ${ns}`);
    for (const t of groups.get(ns)!) {
      const sig = `${t.id}(${argSignature(t)})`;
      out.push(`### ${sig}`);
      out.push(t.description);
      if (t.examples?.length) {
        const ex = t.examples[0]!;
        out.push(`  e.g. ${JSON.stringify(ex.args)}`);
      }
      out.push('');
    }
  }
  return out.join('\n').trim();
}

function argSignature(t: ToolDef): string {
  const shape = (t.args as any)?._def?.shape?.();
  if (!shape || typeof shape !== 'object') return '';
  return Object.keys(shape).join(', ');
}

export function renderPrompt(parts: { datasets: string; tools: string; examples: string }): string {
  return templateRaw
    .replace('{{datasets_block}}', parts.datasets)
    .replace('{{tools_block}}', parts.tools)
    .replace('{{examples_block}}', parts.examples);
}
