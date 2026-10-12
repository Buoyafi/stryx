import { useState } from 'react';
import { setToken, clearToken, apiRequest, ApiError } from './lib/api';
import { Notice } from './components/Notice';

/** Single-operator login: enter the API token once. */
export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function submit() {
    setError(null);
    setChecking(true);
    setToken(value.trim());
    try {
      // Hit a protected endpoint to validate the token for real.
      await apiRequest('/wallets');
      onAuthed();
    } catch (err) {
      // A failed check must not leave a token behind that would fake a signed-in state on reload.
      clearToken();
      setChecking(false);
      if (err instanceof ApiError && err.status === 401) {
        setError('Token rejected.');
      } else if (err instanceof ApiError) {
        setError(`API error (HTTP ${err.status}).`);
      } else {
        setError('API unreachable.');
      }
    }
  }

  return (
    // The column may shrink below 380px, so the card never pushes the page wider than a phone.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 380px)', justifyContent: 'center', alignContent: 'center', flex: 1, padding: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, marginBottom: 4 }}>Operator console</h1>
        <p style={{ color: 'var(--stryx-sub)', marginBottom: 24 }}>Enter your API token to continue.</p>
        <input
          type="password"
          className="mono"
          placeholder="API token"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && value && submit()}
          autoFocus
        />
        {error && <Notice tone="error">{error}</Notice>}
        <button
          className="primary"
          style={{ width: '100%', marginTop: 16 }}
          onClick={submit}
          disabled={!value || checking}
        >
          {checking ? 'Verifying…' : 'Continue'}
        </button>
      </div>
    </div>
  );
}
