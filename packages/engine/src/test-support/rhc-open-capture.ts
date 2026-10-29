import { type Address, encodeAbiParameters, type Hex, keccak256, numberToHex, toBytes } from "viem";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "../protocols/uniswap-v4/constants";
import type { RpcStateOverrides } from "../protocols/uniswap-v4/open-chain";

/**
 * Test-only helpers for the recorded open-position captures. The capture account is a THROWAWAY key derived from
 * a public label: it has never held funds and exists only inside eth_simulateV1 / eth_call state overrides.
 */
export function captureAccountKey(): Hex {
  return keccak256(toBytes("sofinance-rhc-univ4-open-capture-throwaway-v1"));
}

/** SPCX (OpenZeppelin v5 ERC20, namespaced storage) and SPCXon (Ondo GM token, balances at slot 51). */
const SPCX_ERC20_BASE = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const SPCXON_BALANCES_SLOT = 51n;

const mapSlot = (key: Address, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [key, slot]));
const nestedSlot = (owner: Address, spender: Address, slot: bigint) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, mapSlot(owner, slot)]));

/** Balances of both tokens, ERC20 allowance → Permit2 (MaxUint), and gas money for the capture account. */
export function captureOverrides(user: Address, amount: bigint): RpcStateOverrides {
  const pool = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
  const max = numberToHex((1n << 256n) - 1n, { size: 32 });
  const value = numberToHex(amount, { size: 32 });
  return {
    [pool.currency0.address]: { stateDiff: {
      [mapSlot(user, SPCX_ERC20_BASE)]: value,
      [nestedSlot(user, UNIV4_RHC.permit2, SPCX_ERC20_BASE + 1n)]: max,
    } },
    [pool.currency1.address]: { stateDiff: {
      [mapSlot(user, SPCXON_BALANCES_SLOT)]: value,
      [nestedSlot(user, UNIV4_RHC.permit2, SPCXON_BALANCES_SLOT + 1n)]: max,
    } },
    [user]: { balance: numberToHex(10n ** 16n) },
  };
}
