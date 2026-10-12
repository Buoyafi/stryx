import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { chainById, explorerTxUrl } from '@stryx/chains';
import { toast } from '@stryx/toast-ui';
import { ApiError, apiRequest } from '../../lib/api';
import { OUTCOME_UNKNOWN, describeMintError, isRefusal } from '../../lib/mint-error';
import { shortError } from '../../lib/short-error';
import { WalletPicker } from '../WalletPicker';
import { Notice } from '../Notice';
import { DateTimePicker } from '../DateTimePicker';

interface WalletSummary {
  id: string;
  address: string;
  label: string | null;
  tier: string;
  status: string;
}

interface MintParamsJson {
  mintPrice: string;
  maxTotalMintableByWallet: number;
  startTime: number;
  endTime: number;
  dropStageIndex: number;
  maxTokenSupplyForStage: string;
  feeBps: number;
  restrictFeeRecipients: boolean;
}

const PROOF_ITEM = /^0x[a-fA-F0-9]{64}$/;
const DIGITS = /^\d+$/;

function parseProof(text: string): { ok: true; value: string[] } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Proof is not valid JSON.' };
  }
  if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string' && PROOF_ITEM.test(p))) {
    return { ok: false, error: 'Proof must be a JSON array of 0x-prefixed 32-byte hashes.' };
  }
  return { ok: true, value: parsed };
}

function parseMintParams(text: string): { ok: true; value: MintParamsJson } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: 'Mint params are not valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'Mint params must be a JSON object.' };
  const p = parsed as Record<string, unknown>;
  const intFields = ['maxTotalMintableByWallet', 'startTime', 'endTime', 'dropStageIndex', 'feeBps'] as const;
  for (const key of intFields) {
    if (typeof p[key] !== 'number' || !Number.isInteger(p[key]) || (p[key] as number) < 0) {
      return { ok: false, error: `"${key}" must be a non-negative integer.` };
    }
  }
  for (const key of ['mintPrice', 'maxTokenSupplyForStage'] as const) {
    if (typeof p[key] !== 'string' || !DIGITS.test(p[key] as string)) {
      return { ok: false, error: `"${key}" must be a numeric string (on-chain values don't fit a JS number).` };
    }
  }
  if (typeof p.restrictFeeRecipients !== 'boolean') return { ok: false, error: '"restrictFeeRecipients" must be true or false.' };
  return {
    ok: true,
    value: {
      mintPrice: p.mintPrice as string,
      maxTotalMintableByWallet: p.maxTotalMintableByWallet as number,
      startTime: p.startTime as number,
      endTime: p.endTime as number,
      dropStageIndex: p.dropStageIndex as number,
      maxTokenSupplyForStage: p.maxTokenSupplyForStage as string,
      feeBps: p.feeBps as number,
      restrictFeeRecipients: p.restrictFeeRecipients as boolean,
    },
  };
}

const PROOF_PLACEHOLDER = '["0x1111111111111111111111111111111111111111111111111111111111111111"]';
const PARAMS_PLACEHOLDER =
  '{\n  "mintPrice": "10000000000000000",\n  "maxTotalMintableByWallet": 3,\n  "startTime": 1700000000,\n  "endTime": 1700003600,\n  "dropStageIndex": 1,\n  "maxTokenSupplyForStage": "500",\n  "feeBps": 250,\n  "restrictFeeRecipients": true\n}';

interface Result {
  status: 'sent' | 'scheduled' | 'failed' | 'unknown';
  detail: string;
  hash?: `0x${string}`;
}

/**
 * The one case the phase list can't cover: an allow-list drop OpenSea doesn't list at all, where the
 * operator already has a Merkle proof and the stage's mintParams from the creator (or their own
 * trusted source) and just needs to submit them.
 */
export function DirectProofMint({ chainId, nftContract }: { chainId: number; nftContract: string }) {
  const [open, setOpen] = useState(false);
  const [walletId, setWalletId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [proofText, setProofText] = useState('');
  const [paramsText, setParamsText] = useState('');
  const [timing, setTiming] = useState<'now' | 'schedule'>('now');
  const [executeAt, setExecuteAt] = useState('');
  const [result, setResult] = useState<Result | null>(null);

  const { data: walletsRaw } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiRequest<WalletSummary[]>('/wallets'),
    staleTime: 30_000,
    enabled: open,
  });
  const wallets = walletsRaw ?? [];

  const proof = parseProof(proofText || '[]');
  const params = parseMintParams(paramsText || '{}');
  const qty = Number(quantity);
  const validQuantity = Number.isInteger(qty) && qty > 0 && qty <= 50;
  const validCore = walletId !== '' && validQuantity && proofText.trim() !== '' && proof.ok && paramsText.trim() !== '' && params.ok;
  const validSchedule = timing === 'now' || executeAt !== '';
  const valid = validCore && validSchedule;

  const submit = useMutation({
    mutationFn: async (): Promise<Result> => {
      if (!proof.ok || !params.ok) throw new Error('unreachable: submit disabled until valid');
      if (timing === 'now') {
        const r = await apiRequest<{ hash: `0x${string}` }>('/mints/seadrop/allowlist', {
          method: 'POST',
          body: { walletId, nftContract, chainId, quantity: qty, proofSource: 'direct', proof: proof.value, mintParams: params.value },
        });
        return { status: 'sent', detail: 'Sent.', hash: r.hash };
      }
      const r = await apiRequest<{ jobId: string }>('/schedules/mints', {
        method: 'POST',
        body: { kind: 'allowlist-direct', walletId, nftContract, chainId, quantity: qty, proof: proof.value, mintParams: params.value, executeAt: new Date(executeAt).toISOString() },
      });
      return { status: 'scheduled', detail: `Scheduled (job ${r.jobId}).` };
    },
    onSuccess: (r) => {
      setResult(r);
      // Ambient ping; the inline result row above keeps the explorer link/detail.
      toast.success(r.status === 'sent' ? 'Mint sent' : 'Mint scheduled', r.hash ? `${r.hash.slice(0, 10)}…` : undefined);
    },
    onError: (err) => {
      // A mint request that got no clear refusal may still have gone out.
      if (timing === 'now' && !isRefusal(err)) {
        const body = err instanceof ApiError ? (err.body as { hash?: `0x${string}` } | null) : null;
        setResult({ status: 'unknown', detail: OUTCOME_UNKNOWN, ...(body?.hash ? { hash: body.hash } : {}) });
        toast.error('Check before retrying', OUTCOME_UNKNOWN);
        return;
      }
      const detail = describeMintError(err);
      setResult({ status: 'failed', detail });
      toast.error('Mint failed', shortError(detail, 80));
    },
  });

  const chain = chainById(chainId);
  const link = result?.hash && chain ? explorerTxUrl(chain, result.hash) : undefined;

  return (
    <section style={{ marginTop: 24, maxWidth: 640, border: '1px solid var(--dash-line-strong)', borderRadius: 'var(--radius)', padding: 16 }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', border: 'none', background: 'transparent', padding: 0, minHeight: 0 }}
      >
        <span style={{ fontSize: 14, fontWeight: 700 }}>Manual allow-list mint</span>
        <span style={{ color: 'var(--stryx-sub)', fontSize: 12 }}>{open ? '▴ hide' : '▾ a proof OpenSea does not list'}</span>
      </button>

      {open && (
        <div style={{ marginTop: 12 }}>
          <p style={{ color: 'var(--stryx-sub)', fontSize: 12, marginBottom: 12 }}>
            For an allow-list stage OpenSea does not have data for. Paste the Merkle proof and stage mint params from the creator, for one wallet.
          </p>

          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>Wallet</label>
          <div style={{ marginBottom: 12 }}>
            <WalletPicker wallets={wallets} chainId={String(chainId)} selectedId={walletId} onSelect={setWalletId} />
          </div>

          <label style={{ display: 'block', fontSize: 12, marginBottom: 4 }}>
            Quantity
            <input className="mono" style={{ width: 70, display: 'block', marginTop: 4 }} value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          </label>

          <label style={{ display: 'block', fontSize: 12, margin: '12px 0 4px' }}>Proof (JSON array)</label>
          <textarea
            className="mono"
            rows={3}
            style={{ width: '100%', fontSize: 12 }}
            placeholder={PROOF_PLACEHOLDER}
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
          />
          {proofText.trim() !== '' && !proof.ok && <p style={{ color: 'var(--dash-fail-text)', fontSize: 12, margin: '4px 0 0' }}>{proof.error}</p>}

          <label style={{ display: 'block', fontSize: 12, margin: '12px 0 4px' }}>Mint params (JSON object)</label>
          <textarea
            className="mono"
            rows={8}
            style={{ width: '100%', fontSize: 12 }}
            placeholder={PARAMS_PLACEHOLDER}
            value={paramsText}
            onChange={(e) => setParamsText(e.target.value)}
          />
          {paramsText.trim() !== '' && !params.ok && <p style={{ color: 'var(--dash-fail-text)', fontSize: 12, margin: '4px 0 0' }}>{params.error}</p>}

          <div style={{ display: 'flex', gap: 4, margin: '12px 0' }}>
            <button
              type="button"
              style={{ fontSize: 12, borderColor: timing === 'now' ? 'var(--stryx-accent)' : 'var(--dash-line-strong)', background: timing === 'now' ? 'var(--dash-raised)' : 'transparent' }}
              onClick={() => setTiming('now')}
            >
              Now
            </button>
            <button
              type="button"
              style={{ fontSize: 12, borderColor: timing === 'schedule' ? 'var(--stryx-accent)' : 'var(--dash-line-strong)', background: timing === 'schedule' ? 'var(--dash-raised)' : 'transparent' }}
              onClick={() => setTiming('schedule')}
            >
              Schedule for later
            </button>
          </div>

          {timing === 'schedule' && (
            <label style={{ display: 'block', fontSize: 12, marginBottom: 12 }}>
              Runs at
              <DateTimePicker aria-label="Runs at" style={{ display: 'block', marginTop: 4 }} value={executeAt} onChange={setExecuteAt} min={() => Date.now()} />
            </label>
          )}

          <button type="button" className="primary" disabled={!valid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? 'Submitting…' : timing === 'now' ? 'Mint now' : 'Schedule mint'}
          </button>

          {result && (
            <Notice
              tone={result.status === 'failed' ? 'error' : result.status === 'unknown' ? 'warn' : 'ok'}
              compact
              className="notice--spaced"
              action={
                link ? (
                  <a href={link} target="_blank" rel="noreferrer noopener">
                    View
                  </a>
                ) : undefined
              }
            >
              {result.detail}
            </Notice>
          )}
        </div>
      )}
    </section>
  );
}
