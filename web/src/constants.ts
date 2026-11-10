import type { Model } from './types';

export const MODEL_DESC: Record<string, string> = {
  'gpt-6-astra': 'complex work',
  'gpt-6.1-sol': 'browser, structure',
  'gpt-6-luna': 'structure, speed',
  'gpt-5.6-sol': 'browser, structure',
  'gpt-5.6-terra': 'structure, speed',
  sonnet: 'research, drafts',
  opus: 'strategy',
  fable: 'skeptic',
  haiku: 'fast, cheap',
};

export const RECOMMENDED_MODEL: Model = {
  id: 'recommended',
  label: 'Recommended',
  family: 'Supreme',
  provider: 'claude',
  cli: 'recommended',
};

export interface PerformanceStop {
  id: string;
  label: string;
  desc: string;
  outcome: string;
  monthly: number;
}

export const PERFORMANCE_STOPS: PerformanceStop[] = [
  { id: 'max-performance', label: 'Max performance', desc: 'Top models, max effort, every step', outcome: 'Top models on every step', monthly: 210 },
  { id: 'favor-quality', label: 'Favor quality', desc: 'Top models unless clearly mechanical', outcome: 'Top models on ~1 in 2 steps', monthly: 96 },
  { id: 'balanced', label: 'Balanced', desc: 'Top models where it matters', outcome: 'Top models on ~1 in 4 steps', monthly: 57 },
  { id: 'lean', label: 'Lean', desc: 'Cheap first, escalate on judgment', outcome: 'Top models on ~1 in 8 steps', monthly: 31 },
  { id: 'max-roi', label: 'Max ROI', desc: 'Cheapest that clears the bar', outcome: 'Cheap models everywhere', monthly: 16 },
];

export const EFFORTS: [string, string][] = [
  ['Low', 'fast, cheap'],
  ['Medium', ''],
  ['High', ''],
  ['Extra high', 'slow, careful'],
  ['Maximum', 'deepest, slowest'],
];

export const EFFORT_NAMES = EFFORTS.map((e) => e[0]);
