import type { Pane } from '../types';

export const PANE_MIN_WIDTH = 260;
export const PANE_DEFAULT_WIDTH = 280;
export const PANE_DIVIDER_WIDTH = 9;

export function paneWeight(pane: Pick<Pane, 'width'> | undefined): number {
  const width = Number(pane?.width);
  return Number.isFinite(width) && width > 0 ? width : 1;
}

export function paneGridTemplate(weights: number[]): string {
  const safeWeights = weights.map((width) => (
    Number.isFinite(width) && width > 0 ? width : 1
  ));
  const total = safeWeights.reduce((sum, width) => sum + width, 0);
  const scale = total > 0 && total < 1 ? 1 / total : 1;

  return safeWeights.flatMap((width, index) => [
    `minmax(${PANE_MIN_WIDTH}px, ${Math.max(0.001, width * scale)}fr)`,
    ...(index < weights.length - 1 ? [`${PANE_DIVIDER_WIDTH}px`] : []),
  ]).join(' ');
}

export function paneTrackMinWidth(count: number): string {
  const minimum = Math.max(1, count) * PANE_DEFAULT_WIDTH + Math.max(0, count - 1) * PANE_DIVIDER_WIDTH;
  return `max(100%, ${minimum}px)`;
}
