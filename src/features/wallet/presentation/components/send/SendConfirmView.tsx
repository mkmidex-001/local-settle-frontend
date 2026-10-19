"use client";

import React, { useEffect, useState } from "react";
import type { RecipientInfo } from "./send-types";
import { formatAssetAmount } from "@/lib/formatCurrency";
import { AlertTriangle, ArrowLeft, Send } from "lucide-react";

interface SendConfirmViewProps {
  recipient: RecipientInfo;
  amount: string;
  assetName: string;
  fee: string | null;
  memo?: string | null;
  networkFee?: string | null;
  total?: string | null;
  isStale?: boolean;
  onRefresh?: () => void;
  network?: string | null;
  onBack: () => void;
  onConfirm: () => void;
  isLoading?: boolean;
}

export function SendConfirmView({
  recipient,
  amount,
  assetName,
  fee,
  memo,
  networkFee,
  total,
  isStale = false,
  onRefresh,
  network,
  onBack,
  onConfirm,
  isLoading = false,
}: SendConfirmViewProps) {
  const [trustlineAcknowledged, setTrustlineAcknowledged] = useState(false);
  const needsTrustlineAcknowledgement = assetName === "USDC" && !recipient.hasUsdcTrustline;

  useEffect(() => {
    setTrustlineAcknowledged(false);
  }, [recipient.address, recipient.hasUsdcTrustline]);

  const feeDisplay = fee === null
    ? "Not provided by server"
    : Number(fee) === 0
      ? "0 (no platform fee)"
      : `${formatAssetAmount(fee)} ${assetName}`;
  const networkFeeDisplay = networkFee ? `${formatAssetAmount(networkFee)} XLM` : "Not provided by server";
  const amountDisplay = formatAssetAmount(amount || "0");
  const totalDisplay = total ? `${formatAssetAmount(total)} ${assetName}` : "Not provided by server";

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* Recipient Details Card */}
      <div className="bg-[#081521] border border-[#11212E] rounded-2xl p-5">
        <p className="text-[#9BABB7] text-[11px] font-bold uppercase tracking-wider mb-3">
          Sending to
        </p>
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-full bg-[#1a2a3a] border border-[#2a3a1a] flex items-center justify-center text-[#55D6BE] font-bold text-sm shrink-0 shadow-inner">
            {recipient.alias ? recipient.alias.slice(0, 2).toUpperCase() : "G"}
          </div>
          <div className="flex flex-col min-w-0">
            {recipient.alias && (
              <span className="text-white font-bold text-base tracking-tight truncate">
                {recipient.alias}
              </span>
            )}
            <span data-testid="resolved-recipient-address" className="text-[#C2C7D0] text-xs font-mono break-all">
              <span className="break-all">{recipient.address}</span>
            </span>
            {!recipient.exists && (
              <span className="text-amber-300 text-xs mt-2 font-medium">
                This Stellar account is not funded or active yet. It must be activated before you can send.
              </span>
            )}
          </div>
        </div>

        {/* Warning if USDC and no trustline */}
        {recipient.exists && assetName === "USDC" && !recipient.hasUsdcTrustline && (
          <div className="mt-4 p-3 bg-amber-950/30 border border-amber-500/40 rounded-xl flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <p className="text-amber-300 text-xs leading-relaxed">
              The recipient does not have a USDC trustline. They must establish one before this account can receive USDC; otherwise the transfer will fail.
            </p>
          </div>
        )}
        {needsTrustlineAcknowledgement && (
          <label className="mt-3 flex items-start gap-2 text-xs text-[#C2C7D0]">
            <input
              type="checkbox"
              checked={trustlineAcknowledged}
              onChange={(event) => setTrustlineAcknowledged(event.target.checked)}
              className="mt-0.5 accent-[#55D6BE]"
            />
            I understand the recipient needs a USDC trustline before I sign this transfer.
          </label>
        )}
      </div>

      {memo && (
        <div className="bg-[#081521] border border-[#11212E] rounded-2xl p-5">
          <p className="text-[#9BABB7] text-[11px] font-bold uppercase tracking-wider mb-2">Stellar text memo</p>
          <p className="text-white text-sm break-all">{memo}</p>
        </div>
      )}

      {/* Transaction Details Card */}
      <div className="bg-[#081521] border border-[#11212E] rounded-2xl p-5">
        <p className="text-[#9BABB7] text-[11px] font-bold uppercase tracking-wider mb-3">
          Transfer Summary
        </p>
        <div className="space-y-3">
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#9BABB7]">Network</span>
            <span className="text-white font-bold">{network || process.env.NEXT_PUBLIC_STELLAR_NETWORK || "TESTNET"}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#9BABB7]">Transfer Amount</span>
            <span className="text-white font-bold tabular-nums">
              {amountDisplay} {assetName}
            </span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#9BABB7]">Platform Fee</span>
            <span className="text-white font-bold tabular-nums">
              {feeDisplay}
            </span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-[#9BABB7]">Stellar Network Fee</span>
            <span className="text-white font-bold tabular-nums">{networkFeeDisplay}</span>
          </div>
          <div className="w-full h-px bg-[#11212E] my-2" />
          <div className="flex justify-between items-center text-base">
            <span className="text-[#C2C7D0] font-semibold">Total Debit</span>
            <span className="text-[#55D6BE] font-black tabular-nums text-lg">
              {totalDisplay}
            </span>
          </div>
        </div>
        <details id="fee-details" className="mt-4 text-xs text-[#9BABB7]">
          <summary className="cursor-pointer text-[#55D6BE]">How transfer fees work</summary>
          <p className="mt-2">The platform fee and amount above come from the server&apos;s prepare response. Stellar also applies a network fee when the signed transaction is submitted. That network fee is separate from the platform fee and is not included in this total.</p>
        </details>
      </div>

      {isStale && (
        <div role="alert" className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-3 text-sm text-amber-200">
          This prepared transaction is near expiry. Refresh and review the updated fees before signing.
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-3 pt-2">
        <button
          type="button"
          onClick={onBack}
          disabled={isLoading}
          className="flex-1 flex items-center justify-center gap-2 bg-[#11212E] hover:bg-[#172B3A] text-white text-xs font-bold uppercase px-4 py-3.5 rounded-xl transition-all border border-[#172B3A] disabled:opacity-50 cursor-pointer"
        >
          <ArrowLeft size={16} /> Back
        </button>
        <button
          type="button"
          onClick={isStale ? onRefresh : onConfirm}
          disabled={isLoading || !recipient.exists || (!isStale && needsTrustlineAcknowledgement && !trustlineAcknowledged)}
          aria-describedby={!recipient.exists ? "inactive-recipient-help" : undefined}
          className="flex-1 flex items-center justify-center gap-2 bg-[#55D6BE] hover:bg-[#55D6BE] text-black text-xs font-black uppercase tracking-wider px-5 py-3.5 rounded-xl transition-all shadow-lg hover:scale-[1.02] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {isStale ? "Refresh transaction" : <><Send size={15} className="stroke-[2.5]" /> Sign & Send</>}
        </button>
      </div>
      {!recipient.exists && <p id="inactive-recipient-help" className="text-amber-300 text-xs">Activate the recipient account on Stellar before sending.</p>}
    </div>
  );
}
