import { useQuery } from '@tanstack/react-query';
import { Disperse } from '../components/disperse/Disperse';
import type { OurWallet } from '../components/disperse/SourcePicker';
import { apiRequest } from '../lib/api';

/** The operator dashboard's Disperse section. */
export function DispersePage() {
  const { data: chainData } = useQuery({
    queryKey: ['chains'],
    queryFn: () => apiRequest<{ chains: { chainId: number; name: string }[] }>('/chains'),
  });
  const { data: wallets } = useQuery({
    queryKey: ['wallets'],
    queryFn: () => apiRequest<OurWallet[]>('/wallets'),
  });

  return (
    <div>
      <h1 style={{ fontSize: 18, marginBottom: 6 }}>Disperse</h1>
      <p style={{ color: 'var(--stryx-sub)', marginBottom: 20, fontSize: 12.5 }}>
        Send native tokens to many addresses in one go. Send from a wallet connected in this
        browser, or from one of ours.
      </p>
      <Disperse mode="operator" chains={chainData?.chains ?? []} ourWallets={wallets ?? []} />
    </div>
  );
}
