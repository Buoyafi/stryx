import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@stryx/toast-ui';
import { apiRequest } from '../lib/api';

/** Wallet name with an explicit edit affordance. */
export function EditableName({ walletId, label }: { walletId: string; label: string | null }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label ?? '');

  const rename = useMutation({
    mutationFn: (newLabel: string) =>
      apiRequest(`/wallets/${walletId}`, { method: 'PATCH', body: { label: newLabel || null } }),
    onSuccess: () => {
      setEditing(false);
      void queryClient.invalidateQueries({ queryKey: ['wallets'] });
    },
    // The field stays open with what was typed, so it can be fixed and saved again.
    onError: (err) => toast.error('Rename failed', err instanceof Error ? err.message : 'Try again.'),
  });

  function cancel() {
    setValue(label ?? '');
    setEditing(false);
  }

  const iconButton = {
    border: 'none',
    background: 'transparent',
    padding: '2px 4px',
    fontSize: 12,
    lineHeight: 1,
    cursor: 'pointer',
  } as const;

  if (!editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ color: label ? 'inherit' : 'var(--stryx-sub)' }}>{label ?? 'unnamed'}</span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setValue(label ?? '');
            setEditing(true);
          }}
          title="Rename wallet"
          aria-label="Rename wallet"
          style={{ ...iconButton, color: 'var(--stryx-sub)' }}
        >
          &#9998;
        </button>
      </span>
    );
  }

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      onClick={(e) => e.stopPropagation()}
    >
      <input
        value={value}
        autoFocus
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') rename.mutate(value.trim());
          if (e.key === 'Escape') cancel();
        }}
        disabled={rename.isPending}
        style={{ padding: '2px 6px', fontSize: 'inherit', maxWidth: 160 }}
      />
      <button
        onClick={() => rename.mutate(value.trim())}
        disabled={rename.isPending}
        title="Save"
        aria-label="Save name"
        style={{ ...iconButton, color: 'var(--dash-live-text)' }}
      >
        &#10003;
      </button>
      <button
        onClick={cancel}
        disabled={rename.isPending}
        title="Cancel"
        aria-label="Cancel rename"
        style={{ ...iconButton, color: 'var(--stryx-sub)' }}
      >
        &#10005;
      </button>
    </span>
  );
}
