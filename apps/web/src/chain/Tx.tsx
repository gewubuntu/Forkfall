import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Abi, Hex, TransactionReceipt } from 'viem';
import { useConnection, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { friendlyError } from './errors.ts';
import { useHub } from './useHub.ts';

type Status = 'wallet' | 'pending' | 'done' | 'error';
interface Toast { id: number; label: string; status: Status; hash?: Hex; error?: string }

export interface WriteRequest {
  address: `0x${string}`;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
  value?: bigint;
}

interface TxApi {
  /** Send a contract write; resolves with the receipt, or null if it failed or was cancelled (a toast explains). */
  run: (label: string, req: WriteRequest) => Promise<TransactionReceipt | null>;
  busy: boolean;
}

const Ctx = createContext<TxApi | null>(null);
export function useTx(): TxApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTx outside TxProvider');
  return v;
}

/** Transactions with visible state: confirm in wallet → pending (explorer link) → confirmed / failed. */
export function TxProvider({ children }: { children: ReactNode }) {
  const { chainId, explorer } = useHub();
  const { chainId: walletChain } = useConnection();
  const { mutateAsync: switchChain } = useSwitchChain();
  const { mutateAsync: write } = useWriteContract();
  const publicClient = usePublicClient({ chainId: chainId as never });
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [busy, setBusy] = useState(false);
  const next = useRef(1);

  const update = (id: number, t: Partial<Toast>) => setToasts((all) => all.map((x) => (x.id === id ? { ...x, ...t } : x)));
  const dismiss = (id: number) => setToasts((all) => all.filter((x) => x.id !== id));

  const run = useCallback<TxApi['run']>(async (label, req) => {
    const id = next.current++;
    setToasts((all) => [...all.slice(-3), { id, label, status: 'wallet' }]);
    setBusy(true);
    try {
      if (walletChain !== chainId) await switchChain({ chainId: chainId as never });
      const hash = await write({ ...req, chainId: chainId as never } as never);
      update(id, { status: 'pending', hash });
      const receipt = await publicClient!.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error('Transaction reverted on-chain.');
      update(id, { status: 'done' });
      setTimeout(() => dismiss(id), 6000);
      return receipt;
    } catch (e) {
      update(id, { status: 'error', error: friendlyError(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }, [walletChain, chainId, switchChain, write, publicClient]);

  const api = useMemo(() => ({ run, busy }), [run, busy]);
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="tx-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`tx-toast ${t.status}`} role={t.status === 'error' ? 'alert' : 'status'}>
            <span className="tx-icon" aria-hidden>{t.status === 'done' ? '✓' : t.status === 'error' ? '!' : <span className="spinner" />}</span>
            <div className="tx-body">
              <b>{t.label}</b>
              <span>
                {t.status === 'wallet' && 'Confirm in your wallet…'}
                {t.status === 'pending' && 'Waiting for the block…'}
                {t.status === 'done' && 'Confirmed'}
                {t.status === 'error' && t.error}
              </span>
              {t.hash && explorer && <a href={`${explorer}/tx/${t.hash}`} target="_blank" rel="noreferrer">View on explorer ↗</a>}
            </div>
            {(t.status === 'done' || t.status === 'error') && <button onClick={() => dismiss(t.id)} aria-label="Dismiss">✕</button>}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
