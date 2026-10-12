import { useEffect } from 'react';
import { mountToastHost } from './index.js';

/** Mount once near the root of an app. */
export function ToastHost(): null {
  useEffect(() => {
    const controller = mountToastHost();
    return () => controller.destroy();
  }, []);

  return null;
}
