import { useState, useEffect, useCallback, useRef, lazy, Suspense, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { currentAccount, walletSignInEnabled } from './lib/account';
import { ViewerProvider } from './lib/viewer';
import { getToken, clearToken, apiRequest, ApiError, SESSION_ENDED_EVENT } from './lib/api';
import { Login } from './Login';
import { Header } from './components/Header';
import { ChainTooltip } from '@stryx/chain-ui/react';
import { ToastHost } from '@stryx/toast-ui/react';
import { toast } from '@stryx/toast-ui';
import { useChainStatusRows } from './lib/chain-health';
import {
  HomeIcon,
  WalletIcon,
  MintIcon,
  OperationsIcon,
  DisperseIcon,
  ProfileIcon,
  AdminIcon,
} from './lib/icons';
import { Shell } from './components/Shell';
import { TermsGate } from './components/TermsGate';
import type { NavItem } from './components/Sidebar';
import { HomePage } from './pages/HomePage';

// Home ships in the main download; every other page loads when first opened, which keeps the first
// load small.
const WalletsPage = lazy(() =>
  import('./pages/WalletsPage').then((m) => ({ default: m.WalletsPage })),
);
const DispersePage = lazy(() =>
  import('./pages/DispersePage').then((m) => ({ default: m.DispersePage })),
);
const OperationsPage = lazy(() =>
  import('./pages/OperationsPage').then((m) => ({ default: m.OperationsPage })),
);
const MintFlowPage = lazy(() =>
  import('./pages/MintFlowPage').then((m) => ({ default: m.MintFlowPage })),
);
const ProfilePage = lazy(() =>
  import('./pages/ProfilePage').then((m) => ({ default: m.ProfilePage })),
);
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

/** Shown for the moment a page's file is loading. */
function PageLoading() {
  return (
    <div className="page-loading" aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ height: 28, width: 160 }} />
      <div className="skeleton" style={{ height: 140 }} />
    </div>
  );
}
import { useMe } from './lib/profile';
import { useMintWatcher } from './lib/useMintWatcher';
import { mintFeedStore } from './lib/mint-feed-store';
import { clearRecentCollections, setRecentCollectionsAccount } from './lib/recent-collections-store';

// The dashboard's sections, in the order the rail shows them.
const NAV: readonly NavItem[] = [
  { to: '/home', label: 'Home', Icon: HomeIcon, mobile: 'tab' },
  { to: '/wallets', label: 'Wallets', Icon: WalletIcon, mobile: 'tab' },
  { to: '/mint', label: 'Mint', Icon: MintIcon, mobile: 'tab' },
  { to: '/activity', label: 'Activity', Icon: OperationsIcon, mobile: 'tab' },
  {
    to: '/disperse',
    label: 'Disperse',
    Icon: DisperseIcon,
    mobile: 'more',
    hint: 'Fund your wallets in one go',
  },
  {
    to: '/profile',
    label: 'Profile',
    Icon: ProfileIcon,
    mobile: 'more',
    hint: 'Your name, Discord and X',
  },
];

/** Mounted only while signed in. */
function MintWatcher() {
  useMintWatcher();
  return null;
}

/** The header (full lockup) for the screens before sign-in. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
      <Header />
      <ToastHost />
      {children}
    </div>
  );
}

type AuthState =
  | { status: 'checking' }
  /** Wallet sign-in is on and nobody is signed in: Home with the "Got a code?" card. */
  | { status: 'visitor' }
  /** Wallet sign-in is off on this server: the operator token login is the only door. */
  | { status: 'token-login' }
  /** A token is held but the API could not be asked whether it is good: nothing is thrown away. */
  | { status: 'unreachable' }
  | { status: 'member'; signedInWith: 'token' | 'wallet' | 'password' };

/** Only for an ADMIN account (the API checks the role on every request too). */
const ADMIN_ITEM: NavItem = {
  to: '/admin',
  label: 'Admin',
  Icon: AdminIcon,
  mobile: 'more',
  hint: 'Invite codes',
};

/** A visitor sees every section, but only Home opens. */
const VISITOR_NAV: readonly NavItem[] = NAV.map((item) =>
  item.to === '/home' ? item : { ...item, locked: true },
);

export function App() {
  const chainStatusRows = useChainStatusRows();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Three states, not two: a stored token or cookie is only a claim until the API accepts it.
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });
  const me = useMe(auth.status === 'member');
  const isAdmin = me.data?.role === 'ADMIN';

  // This browser's mint record belongs to the signed-in account: switch to theirs once we know who it
  // is, and to none when nobody is signed in.
  const accountId = auth.status === 'member' ? (me.data?.id ?? null) : null;
  const viaToken = auth.status === 'member' && auth.signedInWith === 'token';
  useEffect(() => {
    mintFeedStore.setAccount(accountId ? { id: accountId, claimLegacy: viaToken } : null);
    setRecentCollectionsAccount(accountId ? { id: accountId, claimLegacy: viaToken } : null);
  }, [accountId, viaToken]);

  const resolve = useCallback(async () => {
    if (getToken()) {
      try {
        await apiRequest('/wallets');
        return setAuth({ status: 'member', signedInWith: 'token' });
      } catch (err) {
        // Only a refusal means the token is bad: the API being down must not wipe a good token.
        if (!(err instanceof ApiError && err.status === 401)) return setAuth({ status: 'unreachable' });
        clearToken();
      }
    }
    if (!(await walletSignInEnabled())) return setAuth({ status: 'token-login' });
    try {
      const me = await currentAccount();
      setAuth(
        me
          ? { status: 'member', signedInWith: me.signedInWith ?? 'wallet' }
          : { status: 'visitor' },
      );
    } catch {
      setAuth({ status: 'visitor' });
    }
  }, []);

  useEffect(() => {
    void resolve();
  }, [resolve]);

  // The API refused the sign-in in the middle of a visit: go back to signing in and say why.
  const status = useRef(auth.status);
  status.current = auth.status;
  const [sayEnded, setSayEnded] = useState(false);
  useEffect(() => {
    const onEnded = () => {
      if (status.current !== 'member') return;
      status.current = 'checking';
      mintFeedStore.setAccount(null);
      setRecentCollectionsAccount(null);
      queryClient.clear();
      setAuth({ status: 'checking' });
      setSayEnded(true);
      void resolve();
    };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    return () => window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
  }, [resolve, queryClient]);
  // Said once the next screen is up: a message shown before the swap goes away with the old screen.
  useEffect(() => {
    if (!sayEnded || auth.status === 'checking') return;
    setSayEnded(false);
    // After this render has settled: in development the toast area is set up twice, and a message sent
    // in between is lost.
    if (auth.status !== 'member') setTimeout(() => toast.error('You were signed out', 'Your session ended. Sign in again to carry on.'), 0);
  }, [sayEnded, auth.status]);

  const onSignedIn = useCallback(() => {
    void resolve();
  }, [resolve]);

  if (auth.status === 'checking') {
    return (
      <Frame>
        <div style={{ display: 'grid', placeItems: 'center', flex: 1, color: 'var(--stryx-sub)' }}>
          Verifying session…
        </div>
      </Frame>
    );
  }

  if (auth.status === 'unreachable') {
    return (
      <Frame>
        <div style={{ display: 'grid', placeItems: 'center', alignContent: 'center', gap: 12, flex: 1, padding: 24, textAlign: 'center' }}>
          <p style={{ color: 'var(--stryx-sub)', maxWidth: 380 }}>Stryx is not reachable right now. You are still signed in on this browser.</p>
          <button
            className="primary"
            onClick={() => {
              setAuth({ status: 'checking' });
              void resolve();
            }}
          >
            Try again
          </button>
        </div>
      </Frame>
    );
  }

  // The operator's API-token door: the only one when wallet sign-in is off, and always reachable at
  // /login/token.
  if (
    auth.status === 'token-login' ||
    (auth.status === 'visitor' && location.pathname === '/login/token')
  ) {
    return (
      <Frame>
        <Login
          onAuthed={() => {
            setAuth({ status: 'member', signedInWith: 'token' });
            navigate('/home', { replace: true });
          }}
        />
      </Frame>
    );
  }

  if (auth.status === 'visitor') {
    return (
      <ViewerProvider value={{ kind: 'visitor', onSignedIn }}>
        <Shell items={VISITOR_NAV}>
          <ChainTooltip extraRows={chainStatusRows} />
          <ToastHost />
          <main className="app-main">
            <div className="page">
              <Suspense fallback={<PageLoading />}>
                <Routes>
                  <Route path="/home" element={<HomePage />} />
                  <Route path="*" element={<Navigate to="/home" replace />} />
                </Routes>
              </Suspense>
            </div>
          </main>
        </Shell>
      </ViewerProvider>
    );
  }

  async function logout() {
    // Signing out deletes this account's mint record from the browser: the next person here must not
    // see it.
    mintFeedStore.clear();
    mintFeedStore.setAccount(null);
    clearRecentCollections();
    setRecentCollectionsAccount(null);
    // Both, always: a browser can hold the API token and a wallet session at once.
    status.current = 'checking';
    clearToken();
    try {
      // A wallet session lives in an HttpOnly cookie: only the API can end it.
      await apiRequest('/auth/logout', { method: 'POST' });
    } catch {
      // No such session, or already gone: fall through to the visitor view either way.
    }
    queryClient.clear();
    setAuth({ status: 'checking' });
    navigate('/home', { replace: true });
    void resolve();
  }

  return (
    <ViewerProvider value={{ kind: 'member', signedInWith: auth.signedInWith }}>
      <Shell items={isAdmin ? [...NAV, ADMIN_ITEM] : NAV} onSignOut={() => void logout()}>
        <ChainTooltip extraRows={chainStatusRows} />
        <ToastHost />
        <MintWatcher />
        <TermsGate />
        <main className="app-main">
          <div className="page">
            <Suspense fallback={<PageLoading />}>
              <Routes>
                <Route path="/home" element={<HomePage />} />
                <Route path="/activity" element={<OperationsPage />} />
                {/* Renamed from Operations: old bookmarks and links still land on it. */}
                <Route path="/operations" element={<Navigate to="/activity" replace />} />
                <Route path="/wallets" element={<WalletsPage />} />
                <Route path="/mint" element={<MintFlowPage />} />
                {/* The Schedules page is gone: its links land on Activity, where scheduled mints are managed. */}
                <Route path="/schedules" element={<Navigate to="/activity" replace />} />
                <Route path="/disperse" element={<DispersePage />} />
                <Route path="/profile" element={<ProfilePage />} />
                <Route
                  path="/admin"
                  element={
                    isAdmin ? <AdminPage /> : me.isLoading ? null : <Navigate to="/home" replace />
                  }
                />
                {/* Old /mint/new and /drops links still land somewhere useful. */}
                <Route path="/mint/new" element={<Navigate to="/mint" replace />} />
                <Route path="/drops" element={<Navigate to="/mint" replace />} />
                <Route path="*" element={<Navigate to="/home" replace />} />
              </Routes>
            </Suspense>
          </div>
        </main>
      </Shell>
    </ViewerProvider>
  );
}
