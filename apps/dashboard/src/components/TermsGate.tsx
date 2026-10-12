import { useEffect, useState } from 'react';
import { TERMS_NEEDED_EVENT } from '../lib/api';
import { reasonOf } from '../lib/account';
import { useEscapeToClose } from '../lib/useEscapeToClose';
import { useAcceptTerms, useTermsStatus } from '../lib/terms';
import { Notice } from './Notice';
import { TermsCheckbox } from './TermsCheckbox';

/** For a signed-in account that has not accepted the current Terms of Use and Privacy Policy. */
export function TermsGate() {
  const status = useTermsStatus(true);
  const accept = useAcceptTerms();
  const [open, setOpen] = useState(false);
  const [ticked, setTicked] = useState(false);
  const [asked, setAsked] = useState(false);

  const needed = !!status.data && status.data.required && !status.data.accepted;

  // Ask once per page load when it is needed.
  useEffect(() => {
    if (needed && !asked) {
      setAsked(true);
      setOpen(true);
    }
  }, [needed, asked]);

  // And again whenever a write was turned away for it.
  useEffect(() => {
    const onNeeded = () => {
      void status.refetch();
      setOpen(true);
    };
    window.addEventListener(TERMS_NEEDED_EVENT, onNeeded);
    return () => window.removeEventListener(TERMS_NEEDED_EVENT, onNeeded);
  }, []);

  const close = open && !accept.isPending ? () => setOpen(false) : undefined;
  useEscapeToClose(close);

  if (!open || !needed || !status.data?.termsVersion || !status.data.privacyVersion) return null;
  const { termsVersion, privacyVersion } = status.data;

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal terms-gate" role="dialog" aria-modal="true" aria-labelledby="terms-gate-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="terms-gate-title">Please review our terms</h2>
        <p className="terms-gate__p">To mint, schedule or create wallets you need to accept the current Terms of Use and Privacy Policy. Until then you can still look around, cancel anything scheduled, export a key and move your assets.</p>
        <TermsCheckbox checked={ticked} onChange={setTicked} id="accept-terms-gate" />
        {accept.isError && <Notice tone="error">{reasonOf(accept.error, 'Could not save that. Try again.')}</Notice>}
        <div className="terms-gate__actions">
          <button type="button" onClick={() => setOpen(false)} disabled={accept.isPending}>
            Not now
          </button>
          <button
            type="button"
            className="primary"
            disabled={!ticked || accept.isPending}
            onClick={() => accept.mutate({ termsVersion, privacyVersion }, { onSuccess: () => setOpen(false) })}
          >
            {accept.isPending ? 'Saving…' : 'Accept and continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
