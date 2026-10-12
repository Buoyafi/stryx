import type { SignedMintAttemptRow, SignedMintRunRow } from './signed-mint-repository.js';

/** The per-wallet timing columns, in pipeline order: every value is ms from T-0. */
export const TIMING_COLUMNS = [
  ['calldataMs', 'calldata'],
  ['simulatedMs', 'simulated'],
  ['signedMs', 'signed'],
  ['broadcastMs', 'broadcast'],
  ['confirmedMs', 'confirmed'],
] as const;

const cell = (v: number | null | undefined) => (v === null || v === undefined ? '-' : String(v));

/** Min / median / max of one timing column across the wallets that reached it. */
export function stepStats(attempts: SignedMintAttemptRow[], key: (typeof TIMING_COLUMNS)[number][0] | 'simulateDurationMs') {
  const values = attempts.map((a) => a[key]).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (values.length === 0) return null;
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? Math.round((values[mid - 1]! + values[mid]!) / 2) : values[mid]!;
  return { n: values.length, min: values[0]!, median, max: values[values.length - 1]! };
}

/** The bot's own time: calldata received to sent (to simulated, for a dry run). Same rule as the dashboard card. */
export function botTimeMs(a: SignedMintAttemptRow): number | null {
  if (a.calldataMs === null) return null;
  const end = a.status === 'dry_run_ok' ? a.simulatedMs : a.broadcastMs;
  return end === null ? null : end - a.calldataMs;
}

/** A plain-text report: the run header, one row per wallet, then per-step stats. */
export function formatReport(run: SignedMintRunRow, attempts: SignedMintAttemptRow[]): string {
  const lines: string[] = [];
  lines.push(`Signed mint ${run.jobId}  (${run.stageLabel}, chain ${run.chainId}, ${run.contract})`);
  lines.push(`T-0 ${run.t0.toISOString()}  status ${run.status}${run.dryRun ? '  DRY RUN' : ''}${run.rehearsal ? '  REHEARSAL' : ''}  simulate ${run.simulate ? 'on' : 'off'}`);
  if (run.clockSummary) lines.push(`${run.clockSkewed ? 'CLOCK SKEWED: ' : 'Clock: '}${run.clockSummary}`);
  if (run.notes) lines.push(...run.notes.split('\n').map((n) => `  note: ${n}`));
  lines.push('');

  const header = ['wallet', 'qty', 'status', ...TIMING_COLUMNS.map(([, label]) => label), 'sim took', 'bot time', 'asks', '409s', '429s', 'reason'];
  const rows = attempts.map((a) => [
    a.walletAddress ? `${a.walletAddress.slice(0, 6)}…${a.walletAddress.slice(-4)}` : a.walletId,
    String(a.quantity),
    a.status,
    ...TIMING_COLUMNS.map(([key]) => cell(a[key])),
    cell(a.simulateDurationMs),
    cell(botTimeMs(a)),
    String(a.requestCount ?? 0),
    String(a.notActiveCount),
    String(a.rateLimitedCount),
    a.reason ? `${a.reason}${a.detail ? `: ${a.detail}` : ''}` : a.txHash ?? '',
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const fmt = (r: string[]) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ');
  lines.push(fmt(header), fmt(widths.map((w) => '-'.repeat(w))), ...rows.map(fmt));
  lines.push('');

  lines.push('ms from T-0 (wallets that reached the step): min / median / max');
  for (const [key, label] of TIMING_COLUMNS) {
    const s = stepStats(attempts, key);
    lines.push(`  ${label.padEnd(10)} ${s ? `${s.min} / ${s.median} / ${s.max}  (n=${s.n})` : '-'}`);
  }
  const sim = stepStats(attempts, 'simulateDurationMs');
  lines.push(`  ${'sim took'.padEnd(10)} ${sim ? `${sim.min} / ${sim.median} / ${sim.max}  (n=${sim.n})` : '-'}`);
  const bot = attempts.map(botTimeMs).filter((v): v is number => v !== null).sort((x, y) => x - y);
  const botMid = Math.floor(bot.length / 2);
  const botMedian = bot.length === 0 ? null : bot.length % 2 === 0 ? Math.round((bot[botMid - 1]! + bot[botMid]!) / 2) : bot[botMid]!;
  lines.push(`  ${'bot time'.padEnd(10)} ${bot.length ? `${bot[0]} / ${botMedian} / ${bot[bot.length - 1]}  (n=${bot.length}; calldata to sent, the bot's own share)` : '-'}`);
  return lines.join('\n');
}

/** The same rows as CSV, one line per wallet, for a spreadsheet. */
export function toCsv(run: SignedMintRunRow, attempts: SignedMintAttemptRow[]): string {
  const header = ['jobId', 't0', 'walletId', 'walletAddress', 'quantity', 'status', ...TIMING_COLUMNS.map(([key]) => key), 'simulateDurationMs', 'botTimeMs', 'requestCount', 'notActiveCount', 'rateLimitedCount', 'errorCount', 'txHash', 'gasUsed', 'reason', 'detail'];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = attempts.map((a) =>
    [run.jobId, run.t0.toISOString(), a.walletId, a.walletAddress, a.quantity, a.status, ...TIMING_COLUMNS.map(([key]) => a[key]), a.simulateDurationMs, botTimeMs(a), a.requestCount ?? 0, a.notActiveCount, a.rateLimitedCount, a.errorCount, a.txHash, a.gasUsed, a.reason, a.detail]
      .map(esc)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n');
}
