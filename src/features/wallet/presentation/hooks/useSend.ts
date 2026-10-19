"use client";

import { useCallback, useRef, useState } from "react";
import { useApi } from "@/lib/api";
import { useWallet } from "@/features/wallet";
import { isValidSendAmount } from "@/features/wallet/application/send-amount";
import { trackSendStage } from "../utils/send-analytics";
import { messages, safeUserMessage } from "@/lib/messages";
import { walletApiErrorMessage } from "@/features/wallet/utils/wallet-api-errors";
import { getSendErrorGuidance } from "@/features/wallet/application/send-error-guidance";
import { getStellarNetworkConfig } from "../../config/stellar-network";
import { mapWalletError } from "../../utils/wallet-errors";

export type SendStep =
  | "form"
  | "loading"
  | "confirm"
  | "signing"
  | "submitting"
  | "success"
  | "error"
  | "uncertain"
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
  memo: string | null;
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

const UNCERTAIN_SUBMISSION_PREFIX = "Submission outcome unknown:";

export function useSend() {
  const { apiFetch } = useApi();
  const { signTransaction, assertCorrectNetwork } = useWallet();
  const network = getStellarNetworkConfig().network.toUpperCase();
  const preparedXdrRef = useRef<string | null>(null);
  const preparationInputRef = useRef<{ query: string; amount: string; assetCode?: string; memo?: string } | null>(null);
  const assetCodeRef = useRef("USDC");
  const confirmInFlightRef = useRef(false);

  const [state, setState] = useState<SendState>({
    step: "form",
    recipient: null,
    memo: null,
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
    async (query: string, amount: string, assetCode?: string, memo?: string) => {
      if (!isValidSendAmount(amount)) {
        setState(s => ({ ...s, step: "error", errorMessage: "Enter a positive amount with no more than 7 decimal places." }));
        return;
      }
      const trimmedMemo = memo?.trim() ?? "";
      if (new TextEncoder().encode(trimmedMemo).length > 28) {
        setState(s => ({ ...s, step: "error", errorMessage: "Stellar text memos must be 28 UTF-8 bytes or fewer." }));
        return;
      }
      trackSendStage("resolve", "started");
      preparationInputRef.current = { query, amount, assetCode, memo: trimmedMemo };
      assetCodeRef.current = assetCode && assetCode !== "native" ? assetCode : "XLM";
      setState(s => ({ ...s, step: "loading", errorMessage: null }));
      let resolvingRecipient = true;
      preparedXdrRef.current = null;

      try {
        await assertCorrectNetwork();
        const recipient = await apiFetch<RecipientInfo>(
          `/send/resolve?recipient=${encodeURIComponent(query)}`,
          { defaultError: "Could not resolve recipient" },
        );
        resolvingRecipient = false;

        // Recipient lookup can take long enough for the wallet network to
        // change. Recheck immediately before asking the backend to prepare XDR.
        await assertCorrectNetwork();

        const prepareBody: { recipient: string; amount: string; asset?: string; memo?: string } = {
          recipient: recipient.address,
          amount,
        };
        if (trimmedMemo) prepareBody.memo = trimmedMemo;
        if (assetCode && assetCode !== "native") {
          prepareBody.asset = assetCode;
        }

        const prepared = await apiFetch<Record<string, string>>("/send/prepare", {
          method: "POST",
          body: prepareBody,
          defaultError: "Failed to prepare transaction",
        });
        if (trimmedMemo && prepared.memo !== trimmedMemo) {
          throw new Error("The server did not confirm this memo in the prepared transaction. Memo transfers need backend support; signing was not started.");
        }

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
          memo: trimmedMemo || null,
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
    [apiFetch, assertCorrectNetwork]
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
      const result = await apiFetch<{ hash?: string }>("/send/submit", {
        method: "POST",
        body: { signedXdr },
        defaultError: "Transaction submission failed",
      });
      trackSendStage("submit", "success");
      setState(s => ({ ...s, step: "success", txHash: result.hash ?? null }));
    } catch (err) {
      const outcomeMayBeUnknown = err instanceof TypeError ||
        (err instanceof Error && err.message.startsWith(UNCERTAIN_SUBMISSION_PREFIX));
      trackSendStage("submit", "failure");
      const code = (err as { code?: string })?.code;
      setState(s => ({
        ...s,
        step: outcomeMayBeUnknown ? "uncertain" : "error",
        errorMessage: outcomeMayBeUnknown
          ? "The submission response was lost or timed out. The transaction may still have reached Stellar. Check your wallet activity before attempting another transfer."
          : code
            ? getSendErrorGuidance(walletApiErrorMessage(code), assetCodeRef.current)
            : safeUserMessage(err, messages.wallet.submitFailed),
      }));
    } finally {
      confirmInFlightRef.current = false;
    }
  }, [apiFetch, signTransaction, network, state.preparedAt]);

  const refreshPrepared = useCallback(() => {
    const input = preparationInputRef.current;
    if (!input) {
      setState(s => ({ ...s, needsRefresh: true, errorMessage: "Please return to the form and prepare the transfer again." }));
      return;
    }
    void resolveAndPrepare(input.query, input.amount, input.assetCode, input.memo);
  }, [resolveAndPrepare]);

  const reset = useCallback(() => {
    preparedXdrRef.current = null;
    preparationInputRef.current = null;
    setState({ step: "form", recipient: null, memo: null, preparedAmount: null, fee: null, networkFee: null, total: null, preparedAt: null, needsRefresh: false, txHash: null, errorMessage: null, recipientError: null });
  }, []);

  const clearRecipientError = useCallback(() => setState(s => ({ ...s, recipientError: null })), []);

  const backToConfirm = useCallback(() => {
    setState(s => ({ ...s, step: "confirm", errorMessage: null }));
  }, []);

  return { state, resolveAndPrepare, confirmSend, refreshPrepared, reset, backToConfirm, clearRecipientError };
}
