import { humanMethodId, type HumanMethod } from '@forkfall/sdk';
import type { Address } from 'viem';
import type { Chain, HumanAttestor } from './chain.ts';
import { ApiError } from './lobby.ts';

/**
 * Proof-of-personhood providers. Verification is optional: the Human queue is open to every non-agent
 * wallet; a verified-human badge is what makes a player eligible for season rewards ("play free, verify
 * to earn"). Each verifier checks its own evidence; the referee then records it in HumanRegistry.
 */
export interface HumanVerifier {
  id: HumanMethod;
  label: string;
  /** One line for the profile page: what the player does. */
  description: string;
  available: boolean;
  /** Days an attestation stays valid (0 = no expiry). */
  validDays: number;
  /** Throws ApiError with a player-facing reason if the evidence doesn't hold. */
  check(player: Address, body: Record<string, unknown>): Promise<void>;
}

/** Testnet stand-in: anyone can verify in one click. Clearly labeled; replace before any real launch. */
export const testnetVerifier: HumanVerifier = {
  id: 'testnet',
  label: 'Testnet check',
  description: 'One click, no documents. Testnet only: it does not prove anything and is replaced by a real provider before launch.',
  available: true,
  validDays: 30,
  async check() { /* nothing to prove on testnet */ },
};

/** Listed so players see what's coming; plugged in once API keys exist (HUMAN_PASSPORT_API_KEY etc.). */
export const plannedVerifiers: HumanVerifier[] = [
  {
    id: 'passport', label: 'Human Passport', available: false, validDays: 90,
    description: 'Connect accounts you already have (Google, GitHub, Discord, on-chain history). No documents.',
    async check() { throw new ApiError(501, 'Human Passport is not connected on this server yet'); },
  },
  {
    id: 'coinbase', label: 'Coinbase Verifications', available: false, validDays: 0,
    description: 'One click if your Coinbase account is already verified.',
    async check() { throw new ApiError(501, 'Coinbase Verifications is not connected on this server yet'); },
  },
];

export class HumanVerification {
  readonly verifiers: HumanVerifier[];

  constructor(private chain: Chain, private attestor: HumanAttestor | null, opts: { testnet?: boolean } = {}) {
    this.verifiers = [...(opts.testnet === false ? [] : [testnetVerifier]), ...plannedVerifiers];
  }

  async status(player: Address) {
    const [v, agentId] = await Promise.all([
      this.chain.humanVerification(player).catch(() => null),
      this.chain.agentOf(player).catch(() => 0),
    ]);
    const now = Math.floor(Date.now() / 1000);
    const active = !!v && (v.expiresAt === 0 || v.expiresAt > now);
    return {
      verified: active,
      method: v ? (this.verifiers.find((x) => humanMethodId(x.id) === v.method)?.id ?? 'other') : null,
      verifiedAt: v?.verifiedAt ?? null,
      expiresAt: v?.expiresAt ?? null,
      agentId,
      onchain: this.chain.online,
      canAttest: !!this.attestor,
      methods: this.verifiers.map(({ id, label, description, available, validDays }) => ({
        id, label, description, validDays, available: available && !!this.attestor,
      })),
    };
  }

  async verify(player: Address, method: string, body: Record<string, unknown>) {
    const v = this.verifiers.find((x) => x.id === method);
    if (!v) throw new ApiError(400, `unknown verification method "${method}"`);
    if (!this.attestor) throw new ApiError(503, 'this server cannot write attestations (off-chain mode or AUTO_ATTEST=0)');
    if (!v.available) throw new ApiError(501, `${v.label} is not connected on this server yet`);
    if ((await this.chain.agentOf(player)) > 0) throw new ApiError(403, 'this wallet is a registered agent; agents cannot verify as human');
    await v.check(player, body);
    const expiresAt = v.validDays ? Math.floor(Date.now() / 1000) + v.validDays * 86_400 : 0;
    const tx = await this.attestor.attest(player, humanMethodId(v.id), expiresAt).catch((e) => {
      throw new ApiError(502, `attestation failed: ${(e as Error).message}`);
    });
    return { tx, ...(await this.status(player)) };
  }
}
