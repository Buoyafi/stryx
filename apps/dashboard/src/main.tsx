import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import '@fontsource-variable/inter';
import '@stryx/chain-ui/chain-ui.css';
import '@stryx/toast-ui/toast-ui.css';
import './styles.css';

// One QueryClient for the whole app: TanStack Query's cache/config live here.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,           // don't hammer the API on failure
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
