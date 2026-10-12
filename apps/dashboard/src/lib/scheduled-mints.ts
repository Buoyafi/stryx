import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from '@stryx/toast-ui';
import { apiRequest } from './api';
import { isSuperseded, type ScheduledJob } from './mint-ops';

export interface ScheduledMintsResponse {
  jobs: ScheduledJob[];
}

/** How often the schedule list refreshes when nothing is about to happen, and when something is. */
export const IDLE_POLL_MS = 15_000;
export const BUSY_POLL_MS = 3_000;
/** A job due within this long counts as "about to happen". */
const IMMINENT_MS = 120_000;

/**
 * The API has no push channel (no websockets or SSE), so the schedule list is polled: every 15s
 * normally, every 3s while any job is running or due within two minutes, which is when its state
 * actually changes.
 */
export function scheduledRefetchInterval(jobs: readonly ScheduledJob[] | undefined, now: number): number {
  if (!jobs) return IDLE_POLL_MS;
  const busy = jobs.some((j) => !isSuperseded(j) && (j.state === 'active' || j.state === 'waiting' || (j.state === 'delayed' && j.executeAt - now <= IMMINENT_MS)));
  return busy ? BUSY_POLL_MS : IDLE_POLL_MS;
}

// Module-level, not component state: several components call this hook for the same query, and only
// one toast should fire for one underlying failure, however many of them are mounted.
let toastedForError = false;

/** The scheduler's job list. */
export function useScheduledMints({ drive }: { drive: boolean }) {
  const query = useQuery({
    queryKey: ['schedules'],
    // Own jobs only: an admin's API view is platform-wide, and Activity acts on what it lists.
    queryFn: () => apiRequest<ScheduledMintsResponse>('/schedules/mints?mine=1'),
    ...(drive ? { refetchInterval: (query: { state: { data: ScheduledMintsResponse | undefined } }) => scheduledRefetchInterval(query.state.data?.jobs, Date.now()) } : {}),
  });

  useEffect(() => {
    if (query.isError && !toastedForError) {
      toastedForError = true;
      toast.error('Could not load scheduled mints', 'Retry or check your connection.');
    } else if (!query.isError) {
      toastedForError = false;
    }
  }, [query.isError]);

  return query;
}
