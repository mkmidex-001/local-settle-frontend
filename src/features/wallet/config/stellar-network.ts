import { Networks } from "@creit.tech/stellar-wallets-kit";
import type { StellarNetwork } from "../types/wallet-network.types";

export interface StellarNetworkConfig {
  network: StellarNetwork;
  passphrase: Networks;
}

/** Resolve the configured Stellar network and its signing passphrase. */
export function getStellarNetworkConfig(
  value: string | undefined = process.env.NEXT_PUBLIC_STELLAR_NETWORK,
): StellarNetworkConfig {
  const normalized = value?.trim().toLowerCase() || "testnet";
  if (normalized === "testnet") {
    return { network: "testnet", passphrase: Networks.TESTNET };
  }
  if (normalized === "mainnet" || normalized === "public") {
    return { network: "mainnet", passphrase: Networks.PUBLIC };
  }
  throw new Error(`Unsupported Stellar network: ${value}`);
}

/** Network configured for wallet connections and transaction signing. */
export function getConfiguredStellarNetwork(): StellarNetwork {
  return getStellarNetworkConfig().network;
}

export function getConfiguredUsdcIssuer(): string | null {
  const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER?.trim();
  return issuer || null;
}
