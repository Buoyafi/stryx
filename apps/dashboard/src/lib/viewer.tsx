import { createContext, useContext } from 'react';

/** Who is looking. */
export type Viewer =
  | { kind: 'visitor'; onSignedIn: () => void }
  | { kind: 'member'; signedInWith: 'token' | 'wallet' | 'password' };

const ViewerContext = createContext<Viewer>({ kind: 'member', signedInWith: 'token' });

export const ViewerProvider = ViewerContext.Provider;

export function useViewer(): Viewer {
  return useContext(ViewerContext);
}
