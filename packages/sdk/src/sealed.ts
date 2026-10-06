import { sealedPacks, sealedPoolSeed } from '@forkfall/engine';
import { commitSeed } from './protocol.ts';
import type { SealedRunView } from './client.ts';

export interface SealedProof { ok: boolean; commitOk: boolean; poolOk: boolean; detail: string }

/**
 * Check a finished Sealed run: the revealed server seed matches the commitment shown before the run started, and
 * the pool rolls from that seed, your share and the run id (so the referee could not choose your cards).
 */
export function verifySealedRun(run: SealedRunView): SealedProof {
  if (!run.serverSeed) return { ok: false, commitOk: false, poolOk: false, detail: 'the server seed is revealed when the run ends' };
  const commitOk = commitSeed(run.serverSeed) === run.commit;
  const rolled = sealedPacks(sealedPoolSeed(run.serverSeed, run.share, run.id), run.rules);
  const poolOk = JSON.stringify(rolled) === JSON.stringify(run.packs);
  const detail = !commitOk ? 'the server seed does not match its commitment' : !poolOk ? 'the pool does not match the seed' : 'the pool was rolled from the committed seed';
  return { ok: commitOk && poolOk, commitOk, poolOk, detail };
}
