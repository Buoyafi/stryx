import type { Phase } from './collection-phases';

/**
 * Chronological order: start time ascending, so phases read in the order they actually occur (e.g. a
 * GTD allow-list, then an FCFS allow-list, then public), regardless of what order the API happened to
 * return them in, their kind, or their name.
 */
export function sortPhasesChronologically(phases: readonly Phase[]): Phase[] {
  return phases
    .map((phase, sourceIndex) => ({ phase, sourceIndex }))
    .sort((a, b) => {
      const aStart = a.phase.startMs ?? Infinity;
      const bStart = b.phase.startMs ?? Infinity;
      if (aStart !== bStart) return aStart - bStart;
      const aEnd = a.phase.endMs ?? Infinity;
      const bEnd = b.phase.endMs ?? Infinity;
      if (aEnd !== bEnd) return aEnd - bEnd;
      return a.sourceIndex - b.sourceIndex;
    })
    .map(({ phase }) => phase);
}
