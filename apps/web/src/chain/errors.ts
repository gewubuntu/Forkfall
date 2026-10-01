import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, formatUnits } from 'viem';

/** Turn wallet/contract errors into one short, human sentence. */
export function friendlyError(e: unknown): string {
  if (e instanceof BaseError) {
    if (e.walk((x) => x instanceof UserRejectedRequestError)) return 'You cancelled the request in your wallet.';
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    const name = revert?.data?.errorName;
    const args = (revert?.data?.args ?? []) as readonly unknown[];
    switch (name) {
      case 'AlreadyClaimed': return 'You already claimed this starter deck.';
      case 'TooEarly': return 'This pack isn’t ready yet. Wait a couple of blocks and try again.';
      case 'AlreadyOpened': return 'This pack is already open.';
      case 'NotOwner': return 'That pack belongs to another wallet.';
      case 'WrongPayment': return 'Payment didn’t match the pack price. Refresh and try again.';
      case 'BadCount': return 'You can buy 1 to 10 packs at a time.';
      case 'NotEnoughScrap': return `Not enough Scrap: you have ${args[0]}, crafting needs ${args[1]}.`;
      case 'StarterNotScrappable': return 'Soulbound starter cards can’t be scrapped.';
      case 'Cooldown': return `The faucet is on cooldown until ${new Date(Number(args[0]) * 1000).toLocaleString()}.`;
      case 'ERC20InsufficientBalance': return `Not enough test USDC (have ${formatUnits(args[1] as bigint, 6)}).`;
      case 'ERC20InsufficientAllowance': return 'Approval too low. Try again; the app will ask for approval first.';
      case 'ERC1155InsufficientBalance': return 'You don’t own enough copies of that card.';
      default: if (name) return `Transaction reverted: ${name}.`;
    }
    const msg = e.shortMessage || e.message;
    if (/insufficient funds/i.test(msg)) return 'Not enough ETH for gas. Get free testnet ETH from a Base Sepolia faucet.';
    return msg.split('\n')[0];
  }
  const m = (e as Error)?.message ?? String(e);
  return /reject|denied|cancel/i.test(m) ? 'You cancelled the request in your wallet.' : m.split('\n')[0];
}
