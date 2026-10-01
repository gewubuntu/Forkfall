import '@fontsource/pixelify-sans/400.css';
import '@fontsource/pixelify-sans/700.css';
import '@fontsource-variable/inter';
import '@rainbow-me/rainbowkit/styles.css';
import './styles/app.css';

import { darkTheme, RainbowKitProvider } from '@rainbow-me/rainbowkit';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { WagmiProvider } from 'wagmi';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { wagmiConfig } from './wagmi.ts';

const queryClient = new QueryClient();

const theme = darkTheme({
  accentColor: '#3b82f6',
  accentColorForeground: '#ffffff',
  borderRadius: 'medium',
  fontStack: 'system',
  overlayBlur: 'small',
});
theme.colors.modalBackground = '#141823';
theme.colors.modalBorder = '#323a51';
theme.colors.generalBorder = '#252b3c';
theme.colors.profileForeground = '#141823';
theme.fonts.body = "'Inter Variable', Inter, system-ui, sans-serif";

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider theme={theme} modalSize="compact" appInfo={{ appName: 'Forkfall', disclaimer: Disclaimer }}>
          <BrowserRouter>
            <AuthProvider>
              <App />
            </AuthProvider>
          </BrowserRouter>
        </RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

function Disclaimer({ Text }: { Text: React.FC<{ children: React.ReactNode }> }) {
  return <Text>Forkfall is a testnet alpha. Use a wallet with no real funds; cards and tokens have no value.</Text>;
}
