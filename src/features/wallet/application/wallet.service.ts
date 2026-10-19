import { stellarWalletKitService } from "./stellar-wallet-kit.service";
import { ApiError, apiFetch } from "@/lib/api";
import { walletOptions } from "../config/wallet-options";
import { getStellarNetworkConfig } from "../config/stellar-network";

// Última wallet usada
const WALLET_ID_KEY = "wallet:provider";
const PUBLICKEY_KEY = "wallet:publicKey";
const WALLET_CONNECT_TIMEOUT_MS = 30_000;

interface ChallengeResponse {
    challenge: string;
    expiresAt?: string;
}

interface LoginResponse {
    access_token?: string;
    token?: string;
    jwt?: string;
}

function normalizeSignature(signature: string): string {
    const value = signature.trim();
    const validBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
    if (!value || value.length % 4 !== 0 || !validBase64.test(value)) {
        throw new Error("The wallet returned an invalid signature. Reconnect and sign the login request again.");
    }
    return value;
}

function isExpiredChallengeError(error: unknown): boolean {
    if (error instanceof ApiError && error.code === "INVALID_CHALLENGE") {
        return true;
    }
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    return message.toLowerCase().includes("expired");
}

function isRevokedWalletAccess(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false;
    const value = error as { message?: unknown; code?: unknown };
    const message = typeof value.message === "string" ? value.message.toLowerCase() : "";
    return message.includes("permission revoked") || message.includes("access revoked") ||
        message.includes("permission denied") || message.includes("unauthorized");
}

const authInFlight = new Map<string, Promise<string>>();

async function requestChallenge(publicKey: string): Promise<ChallengeResponse> {
    return apiFetch<ChallengeResponse>("/auth/challenge", {
        method: "POST",
        authenticated: false,
        body: { publicKey },
        defaultError: "Could not request authentication challenge.",
    });
}

async function requestLogin(publicKey: string, challenge: string, signature: string): Promise<string> {
    const data = await apiFetch<LoginResponse>("/auth/login", {
        method: "POST",
        authenticated: false,
        body: { publicKey, challenge, signature },
        defaultError: "Could not complete login.",
    });

    return data.access_token || data.token || data.jwt || "";
}

async function signChallenge(challenge: string): Promise<string> {
    const walletId = localStorage.getItem(WALLET_ID_KEY);
    const publicKey = localStorage.getItem(PUBLICKEY_KEY);
    if (!walletId || !publicKey) throw new Error("No wallet connected");

    stellarWalletKitService.setWallet(walletId);
    const signed = await stellarWalletKitService.signMessage(challenge, publicKey);
    return normalizeSignature(signed);
}

export const walletService = {
    // Restaura sesión desde localStorage. Nunca asume que una wallet
    // previamente seleccionada sigue conectada: vuelve a pedir la dirección
    // y la compara contra lo guardado antes de confiar en la sesión.
    async restoreSession(): Promise<{ publicKey: string; walletId: string } | null> {
        const savedWalletId = localStorage.getItem(WALLET_ID_KEY);
        const savedPublicKey = localStorage.getItem(PUBLICKEY_KEY);

        if (!savedWalletId || !savedPublicKey) return null;
        if (!walletOptions.some((wallet) => wallet.enabled && wallet.id === savedWalletId)) {
            this.clearSession();
            return null;
        }

        try {
            stellarWalletKitService.setWallet(savedWalletId);
            const address = await stellarWalletKitService.getAddress();

            if (!address || address !== savedPublicKey) {
                this.clearSession();
                return null;
            }

            return { publicKey: address, walletId: savedWalletId };
        } catch (error) {
            // A temporarily unavailable extension must not erase the saved
            // provider and account. The caller stays disconnected and can
            // retry when the wallet becomes available again.
            if (isRevokedWalletAccess(error)) this.clearSession();
            return null;
        }
    },

    // Conecta la wallet indicada a través de Stellar Wallets Kit
    async connect(walletId: string): Promise<string> {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let publicKey: string;
        try {
            publicKey = await Promise.race([
                stellarWalletKitService.connect(walletId),
                new Promise<never>((_, reject) => {
                    timeoutId = setTimeout(
                        () => reject(new Error("Wallet connection timed out. Please try again.")),
                        WALLET_CONNECT_TIMEOUT_MS,
                    );
                }),
            ]);
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
        }

        localStorage.setItem(WALLET_ID_KEY, walletId);
        localStorage.setItem(PUBLICKEY_KEY, publicKey);
        return publicKey;
    },

    async signTransaction(xdr: string): Promise<string> {
        const walletId = localStorage.getItem(WALLET_ID_KEY);
        const address = localStorage.getItem(PUBLICKEY_KEY);
        if (!walletId) throw new Error("No wallet connected");

        stellarWalletKitService.setWallet(walletId);
        return await stellarWalletKitService.signTransaction(xdr, address ?? undefined);
    },

    async detectNetwork() {
        return await stellarWalletKitService.detectNetwork();
    },

    getExpectedNetwork() {
        return getStellarNetworkConfig().network;
    },

    async authenticate(publicKey: string): Promise<string> {
        const existingAttempt = authInFlight.get(publicKey);
        if (existingAttempt) return existingAttempt;

        const attempt = (async () => {
            let currentChallenge = "";

            try {
            const walletId = localStorage.getItem(WALLET_ID_KEY);
            if (!walletId) throw new Error("No wallet connected");
            if (!stellarWalletKitService.supportsMessageSigning(walletId)) {
                throw new Error("This wallet does not support SEP-43 message signing. Choose a wallet that supports message signing to sign in.");
            }

                const challengeResponse = await requestChallenge(publicKey);
                currentChallenge = challengeResponse.challenge;

                for (let attempt = 0; attempt < 2; attempt += 1) {
                    try {
                        const signature = await signChallenge(currentChallenge);
                        const token = await requestLogin(publicKey, currentChallenge, signature);
                        if (!token) {
                            throw new Error("Authentication response did not include a JWT.");
                        }
                        return token;
                    } catch (error) {
                        if (attempt === 0 && isExpiredChallengeError(error)) {
                            const freshChallenge = await requestChallenge(publicKey);
                            currentChallenge = freshChallenge.challenge;
                            continue;
                        }

                        if (isSignatureCancelled(error)) {
                            throw new Error("Wallet signature is required to verify ownership and complete login.");
                        }

                        throw error;
                    }
                }

                throw new Error("Could not complete login.");
            } catch (error) {
                if (isSignatureCancelled(error)) {
                    throw new Error("Wallet signature is required to verify ownership and complete login.");
                }
                throw error;
            }
        })();

        authInFlight.set(publicKey, attempt);
        try {
            return await attempt;
        } finally {
            if (authInFlight.get(publicKey) === attempt) authInFlight.delete(publicKey);
        }
    },

    clearSession() {
        localStorage.removeItem(WALLET_ID_KEY);
        localStorage.removeItem(PUBLICKEY_KEY);
        void stellarWalletKitService.disconnect();
    },

    forgetWalletSelection() {
        this.clearSession();
    },
};

export function isSignatureCancelled(error: unknown): boolean {
    if (typeof error === "object" && error !== null) {
        const err = error as Record<string, unknown>;

        // Primary detection: Freighter/kit-style rejection { code: -4, message: "..." }
        if (err.code === -4) return true;

        // Fallback: message-based matching for wallets without a reliable numeric code.
        const msg = err.message;
        if (typeof msg === "string") {
            const lower = msg.toLowerCase();
            if (lower.includes("cancel") || lower.includes("reject") || lower.includes("declined")) {
                return true;
            }
        }
    }

    if (error instanceof Error) {
        const msg = error.message.toLowerCase();
        return msg.includes("cancel") || msg.includes("reject") || msg.includes("declined");
    }

    return false;
}
