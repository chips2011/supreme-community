import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { commitPaneResize } from '../actions';
import { PANE_MIN_WIDTH, paneGridTemplate } from '../lib/panes';

interface DragState {
  pointerId: number;
  startX: number;
  startLeftPx: number;
  pairWidthPx: number;
  pairWeight: number;
  track: HTMLElement;
  weights: number[];
  leftWeight: number;
  rightWeight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function paneElements(handle: HTMLElement, leftIdx: number): { left: HTMLElement; right: HTMLElement; track: HTMLElement } | null {
  const track = handle.closest<HTMLElement>('.panes-track');
  const left = track?.querySelector<HTMLElement>(`.pane[data-pane-index="${leftIdx}"]`);
  const right = track?.querySelector<HTMLElement>(`.pane[data-pane-index="${leftIdx + 1}"]`);
  return track && left && right ? { left, right, track } : null;
}

function weightsForPosition(drag: DragState, clientX: number): [number, number] {
  const maxLeft = Math.max(PANE_MIN_WIDTH, drag.pairWidthPx - PANE_MIN_WIDTH);
  const leftPx = clamp(drag.startLeftPx + clientX - drag.startX, PANE_MIN_WIDTH, maxLeft);
  const leftWeight = drag.pairWeight * (leftPx / drag.pairWidthPx);
  return [Math.max(0.001, leftWeight), Math.max(0.001, drag.pairWeight - leftWeight)];
}

export function PaneResizer({ leftIdx, weights }: { leftIdx: number; weights: number[] }) {
  const dragRef = useRef<DragState | null>(null);
  const leftWeight = weights[leftIdx] || 1;
  const rightWeight = weights[leftIdx + 1] || 1;
  const leftPercent = Math.round((leftWeight / (leftWeight + rightWeight)) * 100);

  useEffect(() => () => {
    document.body.classList.remove('resizing-panes');
  }, []);

  const applyDrag = (clientX: number): [number, number] | null => {
    const drag = dragRef.current;
    if (!drag) return null;
    const [nextLeft, nextRight] = weightsForPosition(drag, clientX);
    drag.leftWeight = nextLeft;
    drag.rightWeight = nextRight;
    drag.weights[leftIdx] = nextLeft;
    drag.weights[leftIdx + 1] = nextRight;
    drag.track.style.gridTemplateColumns = paneGridTemplate(drag.weights);
    return [nextLeft, nextRight];
  };

  const finishDrag = (event: PointerEvent<HTMLDivElement>, usePointerPosition: boolean) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (usePointerPosition) applyDrag(event.clientX);
    dragRef.current = null;
    document.body.classList.remove('resizing-panes');
    commitPaneResize(leftIdx, drag.leftWeight, drag.rightWeight);
  };

  const resizeWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const elements = paneElements(event.currentTarget, leftIdx);
    if (!elements) return;
    event.preventDefault();
    const leftPx = elements.left.getBoundingClientRect().width;
    const rightPx = elements.right.getBoundingClientRect().width;
    const pairWidthPx = leftPx + rightPx;
    if (!Number.isFinite(pairWidthPx) || pairWidthPx <= 0) return;
    const step = event.shiftKey ? 72 : 24;
    const nextLeftPx = clamp(leftPx + (event.key === 'ArrowRight' ? step : -step), PANE_MIN_WIDTH, pairWidthPx - PANE_MIN_WIDTH);
    const pairWeight = leftWeight + rightWeight;
    const nextLeft = pairWeight * (nextLeftPx / pairWidthPx);
    commitPaneResize(leftIdx, nextLeft, pairWeight - nextLeft);
  };

  return (
    <div
      className="pane-resizer"
      data-pane-divider={leftIdx}
      role="separator"
      aria-label={`Resize pane ${leftIdx + 1} and pane ${leftIdx + 2}`}
      aria-orientation="vertical"
      aria-valuemin={1}
      aria-valuemax={99}
      aria-valuenow={leftPercent}
      tabIndex={0}
      title="Drag to resize · Arrow keys adjust · Double-click resets"
      onKeyDown={resizeWithKeyboard}
      onDoubleClick={() => {
        const half = (leftWeight + rightWeight) / 2;
        commitPaneResize(leftIdx, half, half);
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const elements = paneElements(event.currentTarget, leftIdx);
        if (!elements) return;
        const leftPx = elements.left.getBoundingClientRect().width;
        const rightPx = elements.right.getBoundingClientRect().width;
        if (leftPx <= 0 || rightPx <= 0) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add('resizing-panes');
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          startLeftPx: leftPx,
          pairWidthPx: leftPx + rightPx,
          pairWeight: leftWeight + rightWeight,
          track: elements.track,
          weights: weights.slice(),
          leftWeight,
          rightWeight,
        };
      }}
      onPointerMove={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) applyDrag(event.clientX);
      }}
      onPointerUp={(event) => finishDrag(event, true)}
      onPointerCancel={(event) => finishDrag(event, false)}
      onLostPointerCapture={(event) => finishDrag(event, false)}
    />
  );
}
