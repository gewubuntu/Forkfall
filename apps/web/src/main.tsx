import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/game.css';
import './styles/collection.css';
import './styles/decks.css';
import './styles/matches.css';
import './styles/profile.css';
import './styles/economy.css';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { WagmiProvider } from 'wagmi';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { ConnectModalProvider } from './components/ConnectModal.tsx';
import { TxProvider } from './chain/Tx.tsx';
import { wagmiConfig } from './wagmi.ts';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <ConnectModalProvider>
          <BrowserRouter>
            <AuthProvider>
              <TxProvider>
                <App />
              </TxProvider>
            </AuthProvider>
          </BrowserRouter>
        </ConnectModalProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);
