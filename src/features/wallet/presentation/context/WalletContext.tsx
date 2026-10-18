"use client";

import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { walletService } from "../../application/wallet.service";
import type { WalletContext, WalletState } from "../../domain/wallet.types";
import { isWalletConnectionCancelled, mapWalletError } from "../../utils/wallet-errors";
import { useRouter } from "next/navigation";
import { useUsers } from "../../../user/hooks/useUsers";
import { useUser } from "../../../user/presentation/context/UserContext";
import { useNotifications } from "@/features/notifications";
import { useQueryClient } from "@tanstack/react-query";

const Context = createContext<WalletContext | null>(null);

const expectedNetwork = walletService.getExpectedNetwork();

const initialState: WalletState = {
    publicKey: null,
    walletId: null,
    isConnected: false,
    isLoading: true,
    error: null,
    expectedNetwork,
    currentNetwork: "unknown",
    isCorrectNetwork: false,
    isCheckingNetwork: false,
};

export function WalletProvider({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [state, setState] = useState<WalletState>(initialState);

    const router = useRouter();
    const { getOrCreateByWallet } = useUsers();
    const { currentUser, setCurrentUser, setAccessToken, logout } = useUser();
    const { notify } = useNotifications();

    // Use refs to avoid stale closures in useEffect without triggering re-runs
    const getOrCreateRef = useRef(getOrCreateByWallet);
    const setCurrentUserRef = useRef(setCurrentUser);
    useEffect(() => { getOrCreateRef.current = getOrCreateByWallet; }, [getOrCreateByWallet]);
    useEffect(() => { setCurrentUserRef.current = setCurrentUser; }, [setCurrentUser]);

    // A restored or switched wallet must still match the API-authenticated user.
    useEffect(() => {
        if (!state.isConnected || !state.publicKey || !currentUser?.publicKey) return;
        if (state.publicKey.trim().toUpperCase() === currentUser.publicKey.trim().toUpperCase()) return;
        setState(initialState);
        logout();
    }, [state.isConnected, state.publicKey, currentUser?.publicKey, logout]);

    const checkNetwork = useCallback(async () => {
        setState((s) => ({ ...s, isCheckingNetwork: true }));
        try {
            const detected = await walletService.detectNetwork();
            const isCorrect = detected === expectedNetwork;
            setState((s) => ({
                ...s,
                currentNetwork: detected,
                isCorrectNetwork: isCorrect,
                isCheckingNetwork: false,
            }));
            return detected;
        } catch {
            setState((s) => ({
                ...s,
                currentNetwork: "unknown",
                isCorrectNetwork: false,
                isCheckingNetwork: false,
            }));
            return "unknown" as const;
        }
    }, []);

    // Restaura sesión al montar (runs once)
    useEffect(() => {
        let cancelled = false;
        walletService.restoreSession().then(async (session) => {
            if (cancelled || !session?.publicKey) {
                if (!cancelled) {
                    const hasSavedSession = Boolean(
                        localStorage.getItem("wallet:provider") && localStorage.getItem("wallet:publicKey"),
                    );
                    setState((s) => ({
                        ...s,
                        isLoading: false,
                        error: hasSavedSession
                            ? "Your saved wallet is temporarily unavailable. Reconnect it to restore your session."
                            : null,
                    }));
                }
                return;
            }

            const detected = await walletService.detectNetwork();
            const isCorrect = detected === expectedNetwork;

            if (!cancelled) {
                setState((s) => ({
                    ...s,
                    publicKey: session.publicKey,
                    walletId: session.walletId,
                    isConnected: true,
                    isLoading: false,
                    currentNetwork: detected,
                    isCorrectNetwork: isCorrect,
                    isCheckingNetwork: false,
                }));
            }

            try {
                const userAccount = await getOrCreateRef.current(session.publicKey);
                if (!cancelled && userAccount) {
                    setCurrentUserRef.current(userAccount);
                }
            } catch {
                // Backend might not be running yet; user data stays from localStorage
            }
        });
        return () => { cancelled = true; };
    }, []);

    // Monitor network changes when wallet is connected
    useEffect(() => {
        if (!state.isConnected) return;

        const handleCheck = () => {
            void checkNetwork();
        };

        window.addEventListener("focus", handleCheck);
        document.addEventListener("visibilitychange", handleCheck);

        // Wallet extensions do not expose a shared network-change event, so
        // poll while the tab is active. This also catches a switch made in
        // the extension without requiring the user to refocus the app.
        const interval = window.setInterval(() => {
            if (document.visibilityState === "visible") handleCheck();
        }, 2_000);

        return () => {
            window.removeEventListener("focus", handleCheck);
            document.removeEventListener("visibilitychange", handleCheck);
            window.clearInterval(interval);
        };
    }, [state.isConnected, checkNetwork]);

    // Wallet extensions can change accounts while the tab is in the background.
    // Revalidate on return and discard the old authenticated session if the
    // provider no longer exposes the account we authenticated.
    useEffect(() => {
        if (!state.isConnected || !state.publicKey) return;
        let checking = false;
        const verifyAccount = async () => {
            if (checking) return;
            checking = true;
            try {
                const session = await walletService.restoreSession();
                if (!session || session.publicKey !== state.publicKey) {
                    walletService.clearSession();
                    setCurrentUser(null);
                    setAccessToken(null);
                    queryClient.clear();
                    setState({ ...initialState, isLoading: false });
                }
            } finally {
                checking = false;
            }
        };
        window.addEventListener("focus", verifyAccount);
        document.addEventListener("visibilitychange", verifyAccount);
        return () => {
            window.removeEventListener("focus", verifyAccount);
            document.removeEventListener("visibilitychange", verifyAccount);
        };
    }, [state.isConnected, state.publicKey, setCurrentUser, setAccessToken, queryClient]);

    const connect = useCallback(async (walletId: string) => {
        // A new provider connection must not reuse another wallet's API token,
        // user profile, or cached account-scoped queries.
        if (state.isConnected || state.publicKey || state.walletId !== walletId) {
            setCurrentUser(null);
            setAccessToken(null);
            queryClient.clear();
        }
        // Switching wallets mid-session: clear the previous wallet's state
        // before establishing the new connection so a stale address never
        // stays visible.
        setState((s) => ({
            ...(s.walletId && s.walletId !== walletId ? initialState : s),
            isLoading: true,
            error: null,
        }));

        try {
            let publicKey: string;
            try {
                publicKey = await walletService.connect(walletId);
            } catch (err) {
                const walletError = err as { code?: number; message?: string };
                const cancelled = walletError?.code === -4 || /cancel|reject|declin/i.test(walletError?.message || "");
                if (!cancelled && typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("localsettle:connectivity", { detail: "wallet-unavailable" }));
                }
                throw err;
            }

            // Check network immediately upon connection
            const detected = await walletService.detectNetwork();
            const isCorrect = detected === expectedNetwork;

            if (expectedNetwork === "testnet") {
                // Environment Check (Horizon Testnet Account existence)
                const horizonRes = await fetch(`https://horizon-testnet.stellar.org/accounts/${publicKey}`);
                if (!horizonRes.ok) {
                    walletService.clearSession();
                    throw new Error("Account not funded or active on Testnet. Please fund your account via Friendbot before connecting.");
                }
            }

            setState({
                publicKey,
                walletId,
                isConnected: true,
                isLoading: false,
                error: null,
                expectedNetwork,
                currentNetwork: detected,
                isCorrectNetwork: isCorrect,
                isCheckingNetwork: false,
            });

            // Challenge-response auth: prove ownership of the address via a
            // signed challenge rather than trusting the public key alone.
            const token = await walletService.authenticate(publicKey);
            if (token) {
                setAccessToken(token);
            }

            // Onboarding logic
            const userAccount = await getOrCreateByWallet(publicKey);
            if (userAccount) {
                setCurrentUser(userAccount);
                if (userAccount.pendingAccountInfo) {
                    router.push("/setupAccount");
                } else {
                    router.push("/dashboard");
                }
            } else {
                router.push("/dashboard");
            }
        } catch (err) {
            if (isWalletConnectionCancelled(err)) {
                walletService.clearSession();
                setState({ ...initialState, isLoading: false, error: null });
                return;
            }
            const msg = mapWalletError(err);
            walletService.clearSession();
            setCurrentUser(null);
            setAccessToken(null);
            queryClient.clear();
            setState({ ...initialState, isLoading: false, error: msg });
            notify("error", msg);
            throw err; // Re-throw to be caught by the UI component
        }
    }, [getOrCreateByWallet, setCurrentUser, setAccessToken, router, notify, queryClient, state]);

    const disconnect = useCallback(() => {
        walletService.clearSession();
        logout();
        setState({
            ...initialState,
            isLoading: false,
        });
    }, [logout]);

    const assertCorrectNetwork = useCallback(async () => {
        const detected = await checkNetwork();
        if (detected !== expectedNetwork) {
            const expCap = expectedNetwork === "testnet" ? "Testnet" : "Mainnet";
            const curCap = detected === "unknown" ? "unknown network" : detected;
            throw new Error(`Wrong Stellar network detected. LocalSettle is configured for ${expCap}, but your wallet is connected to ${curCap}. Switch your wallet to ${expCap} before continuing.`);
        }
    }, [checkNetwork]);

    const signTransaction = useCallback(async (xdr: string) => {
        await assertCorrectNetwork();
        return await walletService.signTransaction(xdr);
    }, [assertCorrectNetwork]);

    return (
        <Context.Provider value={{ ...state, connect, disconnect, signTransaction, checkNetwork, assertCorrectNetwork }}>
            {children}
        </Context.Provider>
    );
}

export function useWalletContext(): WalletContext {
    const ctx = useContext(Context);
    if (!ctx) throw new Error("useWalletContext debe usarse dentro de WalletProvider");
    return ctx;
}
