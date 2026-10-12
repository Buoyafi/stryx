import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@stryx/toast-ui';
import { chainById } from '@stryx/chains';
import { ApiError } from '../../lib/api';
import { fetchVaultSettings, saveVaultSettings } from '../../lib/vault-settings';
import { Switch } from './Switch';
import { StepUpPrompt } from '../StepUpPrompt';
import { Notice } from '../Notice';

const panel = { border: '1px solid var(--dash-line-strong)', borderRadius: 'var(--radius)', padding: 16, marginTop: 12, marginBottom: 20, background: 'var(--stryx-card)', maxWidth: 620 } as const;
const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** One vault per chain: shown for the resolved collection's chain, applies to every mint on it. */
export function VaultSettingsPanel({ chainId }: { chainId: number }) {
  const queryClient = useQueryClient();
  const queryKey = ['vault-settings', chainId];
  const { data } = useQuery({ queryKey, queryFn: () => fetchVaultSettings(chainId) });

  const [enabled, setEnabled] = useState(false);
  const [address, setAddress] = useState('');
  const [loadedFor, setLoadedFor] = useState<number | null>(null);
  const [needsStepUp, setNeedsStepUp] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (data && loadedFor !== chainId) {
    setEnabled(data.enabled);
    setAddress(data.vaultAddress ?? '');
    setLoadedFor(chainId);
  }

  const save = useMutation({
    mutationFn: () => saveVaultSettings({ chainId, enabled, vaultAddress: enabled ? address.trim() : null }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
      toast.success('Vault settings saved');
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 403) {
        setNeedsStepUp(true);
        return;
      }
      if (err instanceof ApiError && err.status === 400) {
        setFormError('Enter a valid vault address.');
        return;
      }
      toast.error('Could not save vault settings');
    },
  });

  if (!data) return null;

  const dirty = enabled !== data.enabled || (enabled && address.trim() !== (data.vaultAddress ?? ''));
  const chainName = chainById(chainId)?.name ?? `chain ${chainId}`;

  return (
    <section style={panel} aria-label="Vault">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12.5 }}>
        <span style={{ fontWeight: 500 }}>Send mints to vault</span>
        <Switch
          checked={enabled}
          onChange={() => {
            setEnabled((v) => !v);
            setFormError(null);
          }}
          label="Send minted NFTs to a vault address"
          labelPosition="none"
        />
      </div>
      <p style={{ color: 'var(--stryx-sub)', fontSize: 12, marginTop: 4 }}>Applies to every mint on {chainName}, not just this collection.</p>

      {enabled && (
        <input
          className="mono"
          style={{ marginTop: 8, width: '100%' }}
          placeholder="0x… vault address"
          aria-label="Vault address"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            setFormError(null);
          }}
        />
      )}

      {formError && (
        <Notice tone="error">{formError}</Notice>
      )}

      {data.lastDrainFailure && (
        <Notice tone="error" detail={data.lastDrainFailure.error ?? 'Unknown error'}>
          {`Vault transfer failed for token #${data.lastDrainFailure.tokenId} (${shortAddr(data.lastDrainFailure.contract)}). It is still in the minting wallet.`}
        </Notice>
      )}

      {dirty && (
        <div style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      )}

      {needsStepUp && (
        <StepUpPrompt
          reason="This changes where newly minted NFTs go."
          onCancel={() => setNeedsStepUp(false)}
          onGranted={() => {
            setNeedsStepUp(false);
            save.mutate();
          }}
        />
      )}
    </section>
  );
}
