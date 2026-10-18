"use client";

import { useCallback, useRef, useState } from "react";
import { useUser } from "@/features/user/presentation/context/UserContext";
import { useWallet } from "@/features/wallet";
import { trackSendStage } from "../utils/send-analytics";
import { apiFailureMessage, messages, safeUserMessage } from "@/lib/messages";
import { walletApiErrorMessage } from "@/features/wallet/utils/wallet-api-errors";
import { getSendErrorGuidance } from "@/features/wallet/application/send-error-guidance";
import { getStellarNetworkConfig } from "../../config/stellar-network";
import { mapWalletError } from "../../utils/wallet-errors";

async function apiFailure(response: Response, fallback: string): Promise<{ message: string; code?: string }> {
  const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
  const code = body.code || body.error;
  return { code, message: code ? walletApiErrorMessage(code) : apiFailureMessage(response.status, fallback) };
}

export type SendStep =
  | "form"
  | "loading"
  | "confirm"
  | "signing"
  | "submitting"
  | "success"
  | "error"
  | "cancelled";

export interface RecipientInfo {
  address: string;
  alias: string | null;
  exists: boolean;
  hasUsdcTrustline: boolean;
}

export interface SendState {
  step: SendStep;
  recipient: RecipientInfo | null;
  preparedAmount: string | null;
  fee: string | null;
  networkFee: string | null;
  total: string | null;
  preparedAt: number | null;
  needsRefresh: boolean;
  network?: string | null;
  txHash: string | null;
  errorMessage: string | null;
  recipientError?: string | null;
}

export function useSend() {
  const { accessToken } = useUser();
  const { signTransaction, assertCorrectNetwork } = useWallet();
  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";
  const network = getStellarNetworkConfig().network.toUpperCase();
  const preparedXdrRef = useRef<string | null>(null);
  const preparationInputRef = useRef<{ query: string; amount: string; assetCode?: string } | null>(null);
  const assetCodeRef = useRef("USDC");
  const confirmInFlightRef = useRef(false);

  const [state, setState] = useState<SendState>({
    step: "form",
    recipient: null,
    preparedAmount: null,
    fee: null,
    networkFee: null,
    total: null,
    preparedAt: null,
    needsRefresh: false,
    txHash: null,
    errorMessage: null,
  });

  const resolveAndPrepare = useCallback(
    async (query: string, amount: string, assetCode?: string) => {
      trackSendStage("resolve", "started");
      preparationInputRef.current = { query, amount, assetCode };
      assetCodeRef.current = assetCode && assetCode !== "native" ? assetCode : "XLM";
      setState(s => ({ ...s, step: "loading", errorMessage: null }));
      let resolvingRecipient = true;
      preparedXdrRef.current = null;

      try {
        await assertCorrectNetwork();
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

        const resolveRes = await fetch(
          `${apiUrl}/send/resolve?recipient=${encodeURIComponent(query)}`,
          { headers }
        );
        if (!resolveRes.ok) {
          const failure = await apiFailure(resolveRes, messages.wallet.resolveFailed);
          throw Object.assign(new Error(failure.message), { code: failure.code });
        }
        const recipient: RecipientInfo = await resolveRes.json();
        resolvingRecipient = false;

        // Recipient lookup can take long enough for the wallet network to
        // change. Recheck immediately before asking the backend to prepare XDR.
        await assertCorrectNetwork();

        const prepareBody: { recipient: string; amount: string; asset?: string } = {
          recipient: recipient.address,
          amount,
        };
        if (assetCode && assetCode !== "native") {
          prepareBody.asset = assetCode;
        }

        const prepareRes = await fetch(`${apiUrl}/send/prepare`, {
          method: "POST",
          headers,
          body: JSON.stringify(prepareBody),
        });
        if (!prepareRes.ok) {
          const failure = await apiFailure(prepareRes, messages.wallet.prepareFailed);
          throw Object.assign(new Error(failure.message), { code: failure.code });
        }
        const prepared = await prepareRes.json() as Record<string, string>;

        const xdr = prepared.xdr ?? prepared.unsignedXdr ?? prepared.txXdr ?? prepared.transaction ?? prepared.envelope ?? null;
        if (!xdr) {
          console.error("[useSend] prepare response missing XDR field:", prepared);
          throw new Error(messages.wallet.transactionMissing);
        }

        preparedXdrRef.current = xdr;
        trackSendStage("resolve", "success");
        setState(s => ({
          ...s,
          step: "confirm",
          recipient,
          preparedAmount: prepared.amount ?? amount,
          fee: prepared.platformFee ?? prepared.fee ?? null,
          networkFee: prepared.networkFee ?? prepared.baseFee ?? null,
          total: prepared.total ?? prepared.totalDebit ?? null,
          preparedAt: Date.now(),
          needsRefresh: false,
          network: prepared.network ?? network,
          recipientError: null,
        }));
      } catch (err) {
        trackSendStage("resolve", "failure");
        const code = (err as { code?: string })?.code;
        const message = code
          ? walletApiErrorMessage(code)
          : safeUserMessage(err, resolvingRecipient ? messages.wallet.resolveFailed : messages.wallet.prepareFailed);
        setState(s => resolvingRecipient
          ? { ...s, step: "form", recipientError: message, errorMessage: null }
          : { ...s, step: "error", errorMessage: message });
      }
    },
    [accessToken, apiUrl, assertCorrectNetwork]
  );

  const confirmSend = useCallback(async () => {
    if (!state.preparedAt || Date.now() - state.preparedAt >= 4 * 60 * 1000) {
      setState(s => ({ ...s, step: "confirm", needsRefresh: true, errorMessage: null }));
      return;
    }
    const xdr = preparedXdrRef.current;
    if (confirmInFlightRef.current) return;
    if (!xdr) {
      setState(s => ({ ...s, step: "error", errorMessage: messages.wallet.transactionMissing }));
      return;
    }

    confirmInFlightRef.current = true;
    setState(s => ({ ...s, step: "signing", errorMessage: null }));
    trackSendStage("confirmation", "success");
    trackSendStage("signing", "started");

    let signedXdr: string;
    try {
      signedXdr = await signTransaction(xdr, network);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message :
        typeof err === "string" ? err :
        "Signing failed";
      const isCancelled = /cancel|decline|reject|denied|user rejected/i.test(msg);
      trackSendStage("signing", isCancelled ? "cancelled" : "failure");
      setState(s => ({
        ...s,
        step: isCancelled ? "cancelled" : "error",
        errorMessage: isCancelled ? null : mapWalletError(err),
      }));
      confirmInFlightRef.current = false;
      return;
    }

    setState(s => ({ ...s, step: "submitting" }));
    trackSendStage("signing", "success");
    trackSendStage("submit", "started");
    // A submission timeout has an unknown outcome. Consume the prepared XDR
    // before sending so retrying cannot submit the same payment twice.
    preparedXdrRef.current = null;
    try {
      const submitHeaders: Record<string, string> = { "Content-Type": "application/json" };
      if (accessToken) submitHeaders["Authorization"] = `Bearer ${accessToken}`;
      const submitRes = await fetch(`${apiUrl}/send/submit`, {
        method: "POST",
        headers: submitHeaders,
        body: JSON.stringify({ signedXdr }),
      });
      if (!submitRes.ok) {
        const body = await submitRes.json().catch(() => ({})) as { message?: string; code?: string; error?: string };
        const guidance = getSendErrorGuidance(`${body.code || body.error || ""} ${body.message || ""}`, assetCodeRef.current);
        throw new Error(guidance);
      }
      const result: { hash?: string } = await submitRes.json();
      trackSendStage("submit", "success");
      setState(s => ({ ...s, step: "success", txHash: result.hash ?? null }));
    } catch (err) {
      trackSendStage("submit", "failure");
      setState(s => ({
        ...s,
        step: "error",
        errorMessage: (err as { code?: string })?.code
          ? walletApiErrorMessage((err as { code: string }).code)
          : safeUserMessage(err, messages.wallet.submitFailed),
      }));
    } finally {
      confirmInFlightRef.current = false;
    }
  }, [accessToken, apiUrl, signTransaction, network, state.preparedAt]);

  const refreshPrepared = useCallback(() => {
    const input = preparationInputRef.current;
    if (!input) {
      setState(s => ({ ...s, needsRefresh: true, errorMessage: "Please return to the form and prepare the transfer again." }));
      return;
    }
    void resolveAndPrepare(input.query, input.amount, input.assetCode);
  }, [resolveAndPrepare]);

  const reset = useCallback(() => {
    preparedXdrRef.current = null;
    preparationInputRef.current = null;
    setState({ step: "form", recipient: null, preparedAmount: null, fee: null, networkFee: null, total: null, preparedAt: null, needsRefresh: false, txHash: null, errorMessage: null, recipientError: null });
  }, []);

  const clearRecipientError = useCallback(() => setState(s => ({ ...s, recipientError: null })), []);

  const backToConfirm = useCallback(() => {
    setState(s => ({ ...s, step: "confirm", errorMessage: null }));
  }, []);

  return { state, resolveAndPrepare, confirmSend, refreshPrepared, reset, backToConfirm, clearRecipientError };
}
