import { PRIVACY_URL, TERMS_URL } from '../lib/terms';

function Doc({ href, children }: { href: string | undefined; children: string }) {
  return href ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <>{children}</>
  );
}

/** The acceptance box shown before a person gets transaction features. */
export function TermsCheckbox({ checked, onChange, id = 'accept-terms' }: { checked: boolean; onChange: (next: boolean) => void; id?: string }) {
  return (
    <label className="terms-check" htmlFor={id}>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        I confirm that I am 18 or older and agree to the Stryx <Doc href={TERMS_URL}>Terms of Use</Doc> and <Doc href={PRIVACY_URL}>Privacy Policy</Doc>. I understand that blockchain transactions are generally irreversible, network fees may be charged even when a transaction fails, and that Stryx wallets may involve encrypted storage of private keys.
      </span>
    </label>
  );
}
