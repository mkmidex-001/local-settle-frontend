"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/lib/api";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "@/lib/api";
import { walletApiErrorMessage } from "@/features/wallet/utils/wallet-api-errors";
import { parseAssetBalances } from "@/lib/api/contracts";
import type { AssetBalance } from "@/lib/api/generated/contracts";
import { useWalletContext } from "../context/WalletContext";

export type { AssetBalance };

export interface BalanceState {
  balance: string | null; // Native XLM balance
  balances: AssetBalance[]; // All balances
  isLoading: boolean;
  isFetching: boolean;
  lastUpdatedAt: number | null;
  error: string | null;
  refetch: () => Promise<void>;
  hasData: boolean;
}

export function useWalletBalance(publicKey: string | null): BalanceState {
  const { apiFetch } = useApi();
  const { isCorrectNetwork, assertCorrectNetwork } = useWalletContext();

  const { data, isLoading, isFetching, dataUpdatedAt, error, refetch: queryRefetch } = useQuery<AssetBalance[], Error>({
    queryKey: queryKeys.wallet.balance(publicKey),
    queryFn: async () => {
      await assertCorrectNetwork();
      return parseAssetBalances(await apiFetch<unknown>(`/stellar/balances/${publicKey}`));
    },
    enabled: !!publicKey && isCorrectNetwork,
  });

  const xlm = data?.find((b) => b.asset_type === "native");
  const balance = xlm ? parseFloat(xlm.balance).toFixed(7) : "0.00";

  return {
    balance: data && isCorrectNetwork ? balance : null,
    balances: isCorrectNetwork ? data || [] : [],
    isLoading,
    isFetching,
    lastUpdatedAt: dataUpdatedAt || null,
    error: error ? walletApiErrorMessage(error instanceof ApiError ? error.code : undefined, error.message) : null,
    hasData: data !== undefined,
    refetch: async () => { await queryRefetch(); },
  };
}
