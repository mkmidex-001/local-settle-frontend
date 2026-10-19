"use client";

import { use, useEffect, useState, useCallback, useRef } from "react";
import { Aside } from "@/app/components/Aside";
import { Header } from "@/app/components/Header";
import { TradeDetails } from "../components/TradeDetails";
import { EscrowTransactionLinks } from "../components/EscrowTransactionLinks";
import { OrderStatusTimeline } from "../components/OrderStatusTimeline";
import { OrderStatusHistory } from "@/features/order/components/OrderStatusHistory";
import dynamic from "next/dynamic";
const TradeEvidenceUploader = dynamic(() => import("../components/TradeEvidenceUploader").then((mod) => mod.TradeEvidenceUploader), { ssr: false });
const EvidencePreview = dynamic(() => import("../components/EvidencePreview").then((mod) => mod.EvidencePreview), { ssr: false });
const Chat = dynamic(() => import("../../components/Chat").then((mod) => mod.Chat), { ssr: false });
import { TradeSafetyControls } from "../../components/TradeSafetyControls";
import { useUser } from "@/features/user/presentation/context/UserContext";
import type { Order } from "@/features/order/models/order";
import { useOrders } from "@/features/order/hooks/useOrders";
import { useOrderExpiry } from "@/features/order/hooks/useOrderExpiry";
import { ApiError } from "@/lib/api";
import { canCancelOrder } from "@/features/order/utils/canCancelOrder";
import { getOrderParticipantRole } from "@/features/order/utils/order-access";
import { createDemoOrder } from "@/features/order/mocks/demo-order";
import { DEMO_MODE } from "@/config/demo-mode";
import { CancelOrderModal } from "../components/CancelOrderModal";
import { DisputeDialog } from "../components/DisputeDialog";
import { useNotifications } from "@/features/notifications";
import { useEscrowStatusSync } from "@/features/escrow/hooks/useEscrowStatusSync";
import type { EscrowStatusEvent } from "@/features/escrow/types/escrow-events.types";
import { getEscrowStatusPresentation } from "@/features/escrow/utils/escrow-status.utils";
import { ArrowLeft, AlertTriangle, Ban, Loader2, RefreshCw } from "lucide-react";
import Link from "next/link";

interface OnChainSnapshot {
    onChainBalance?: unknown;
    onChainData?: unknown;
}

function OnChainEscrowDetails({ escrowId, expectedAmount, assetCode }: { escrowId?: string; expectedAmount?: string; assetCode: string }) {
    const { accessToken } = useUser();
    const [snapshot, setSnapshot] = useState<OnChainSnapshot | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (!escrowId) return;
        const controller = new AbortController();
        const headers: Record<string, string> = {};
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        fetch(`${process.env.NEXT_PUBLIC_API_URL}/escrows/${escrowId}/status`, { headers, signal: controller.signal })
            .then(async response => {
                if (!response.ok) throw new Error("On-chain state unavailable");
                return response.json() as Promise<OnChainSnapshot>;
            })
            .then(setSnapshot)
            .catch(error => {
                if (error instanceof DOMException && error.name === "AbortError") return;
                setFailed(true);
            });
        return () => controller.abort();
    }, [escrowId, accessToken]);

    if (!escrowId) return null;
    const balances = Array.isArray(snapshot?.onChainBalance) ? snapshot.onChainBalance as Record<string, unknown>[] : [];
    const actualBalance = balances.find(item => item.balance !== null && item.balance !== undefined)?.balance
        ?? (typeof snapshot?.onChainBalance === "number" || typeof snapshot?.onChainBalance === "string" ? snapshot.onChainBalance : null);
    const chainEntries = Array.isArray(snapshot?.onChainData) ? snapshot.onChainData as Record<string, unknown>[] : [];
    const milestones = Array.isArray(chainEntries[0]?.milestones) ? chainEntries[0].milestones as Record<string, unknown>[] : [];

    return (
        <section aria-label="On-chain escrow details" className="w-full rounded-xl border border-[#263949] bg-[#0D1D2C] p-4 text-sm">
            <h3 className="mb-3 font-bold text-white">On-chain escrow details</h3>
            {failed ? <p className="text-amber-300">Current chain data could not be loaded.</p> : (
                <div className="space-y-2 text-[#C2C7D0]">
                    <p>Expected amount: <strong className="text-white">{expectedAmount || "Unavailable"} {assetCode}</strong></p>
                    <p>On-chain balance: <strong className="text-white">{actualBalance === null ? "Unavailable" : `${actualBalance} ${assetCode}`}</strong></p>
                    <div>
                        <span>Milestones: </span>
                        {milestones.length ? milestones.map((milestone, index) => (
                            <span key={index} className="mr-2 text-white">
                                {String(milestone.title ?? milestone.name ?? `Milestone ${index + 1}`)} — {String(milestone.status ?? "status unavailable")}
                            </span>
                        )) : <span>Unavailable</span>}
                    </div>
                </div>
            )}
        </section>
    );
}

interface PageProps {
    params: Promise<{ orderId: string }>;
}

function restoreUuidDashes(uuid: string): string {
    if (uuid.length !== 32) return uuid;
    return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

export default function TradePage({ params }: PageProps) {
    const { orderId } = use(params);
    const { currentUser } = useUser();
    const { getOrder, cancelOrder } = useOrders();
    const { notify } = useNotifications();

    const [order, setOrder] = useState<Order | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [errorMsg, setErrorMsg] = useState("");
    const [showCancelModal, setShowCancelModal] = useState(false);
    const [isCancelling, setIsCancelling] = useState(false);
    const [showDisputeDialog, setShowDisputeDialog] = useState(false);
    const fetchVersionRef = useRef(0);
    const escrowEventVersionRef = useRef(0);

    // Demo orders are only fabricated when the demo flag is on. With the flag
    // off (production), /demo and mock-* ids fall through to the real order
    // flow and surface a not-found/error state.
    const isDemoOrder = DEMO_MODE && (orderId === "demo" || orderId.startsWith("mock-"));

    const fetchOrder = useCallback(async () => {
        const requestVersion = ++fetchVersionRef.current;
        const eventVersion = escrowEventVersionRef.current;
        if (isDemoOrder && currentUser) {
            setOrder(createDemoOrder(currentUser));
            setIsLoading(false);
            return;
        }

        try {
            const dashedId = restoreUuidDashes(orderId);
            const data = await getOrder(dashedId);
            if (requestVersion !== fetchVersionRef.current || eventVersion !== escrowEventVersionRef.current) return;
            if (!data) {
                setErrorMsg("Order not found");
            } else {
                setOrder((previous) => {
                    const previousStatus = previous?.escrow?.escrowStatus;
                    const incomingStatus = data.escrow?.escrowStatus;
                    const previousTerminal = previousStatus === "released" || previousStatus === "resolved";
                    const incomingTerminal = incomingStatus === "released" || incomingStatus === "resolved";
                    return previousTerminal && !incomingTerminal ? previous : data;
                });
            }
        } catch (err: unknown) {
            if (requestVersion !== fetchVersionRef.current || eventVersion !== escrowEventVersionRef.current) return;
            console.error("Error fetching order:", err);
            if (err instanceof ApiError && err.status === 403) {
                setErrorMsg("You are not authorized to view this trade.");
            } else if (err instanceof ApiError && err.status === 404) {
                setErrorMsg("Order not found");
            } else {
                setErrorMsg("Error loading order details");
            }
        } finally {
            if (requestVersion === fetchVersionRef.current && eventVersion === escrowEventVersionRef.current) setIsLoading(false);
        }
    }, [orderId, getOrder, isDemoOrder, currentUser]);

    const expiry = useOrderExpiry(order?.expiresAt, () => {
        void fetchOrder();
    });

    useEffect(() => {
        if (currentUser) {
            fetchOrder();
        }
    }, [currentUser, fetchOrder]);

    // Escrow status sync — kept separate from fetchOrder so that only
    // the escrow event triggers a refetch, not every render.
    const handleEscrowStatusChange = useCallback(async (event: EscrowStatusEvent) => {
        escrowEventVersionRef.current += 1;
        setOrder((previous) => previous?.escrow
            ? { ...previous, escrow: { ...previous.escrow, escrowStatus: event.status } }
            : previous);
        await fetchOrder();
    }, [fetchOrder]);

    const { syncState, refresh } = useEscrowStatusSync({
        orderId,
        escrowId: order?.escrow?.escrowId,
        onStatusChange: handleEscrowStatusChange,
        enabled: !!currentUser && !!order?.escrow?.escrowId && !(orderId === "demo" || orderId.startsWith("mock-")),
    });

    const handleCancelOrder = useCallback(async () => {
        if (!order || isDemoOrder) {
            setShowCancelModal(false);
            return;
        }

        if (!canCancelOrder(order, currentUser?.userId ?? "")) {
            setShowCancelModal(false);
            notify("warning", "This order can no longer be cancelled because its status has changed.");
            await fetchOrder();
            return;
        }

        setIsCancelling(true);
        try {
            await cancelOrder(order.orderId);
            setShowCancelModal(false);
            notify("success", "Order cancelled successfully.");
            await fetchOrder();
        } catch (err: unknown) {
            setShowCancelModal(false);
            // Backend rejected because the order's state changed underneath
            // us (e.g. payment was marked while the modal was open) — refresh
            // to show the latest state instead of leaving a stale UI.
            if (err instanceof ApiError && err.status === 409) {
                notify("warning", "This order can no longer be cancelled because its status has changed.");
                await fetchOrder();
                return;
            }
            const msg = err instanceof Error ? err.message : "Failed to cancel the order. Please try again.";
            notify("error", msg);
        } finally {
            setIsCancelling(false);
        }
    }, [order, isDemoOrder, currentUser, cancelOrder, notify, fetchOrder]);

    if (!currentUser) {
        return (
            <div className="flex h-screen w-full overflow-hidden bg-[#081521]">
                <Aside />
                <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                    <Header description="trading floor" title="p2p marketplace" />
                    <main id="main-content" tabIndex={-1} className="flex flex-col items-center justify-center flex-1 bg-[#081521]">
                        <p className="text-white text-lg font-bold font-space">Please log in to view this trade.</p>
                    </main>
                </div>
            </div>
        );
    }

    if (isLoading) {
        return (
            <div className="flex h-screen w-full overflow-hidden bg-[#081521]">
                <Aside />
                <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                    <Header description="trading floor" title="p2p marketplace" />
                    <main id="main-content" tabIndex={-1} className="flex flex-col items-center justify-center flex-1 bg-[#081521]">
                        <Loader2 className="animate-spin h-12 w-12 text-[#55D6BE]" />
                        <p className="text-[#C2C7D0] mt-4 font-semibold font-space">Loading transaction details...</p>
                    </main>
                </div>
            </div>
        );
    }

    if (errorMsg || !order) {
        return (
            <div className="flex h-screen w-full overflow-hidden bg-[#081521]">
                <Aside />
                <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                    <Header description="trading floor" title="p2p marketplace" />
                    <main id="main-content" tabIndex={-1} className="flex flex-col items-center justify-center flex-1 bg-[#081521]">
                        <AlertTriangle className="w-12 h-12 text-[#55D6BE] mb-2" />
                        <p className="text-white text-lg font-bold font-space">{errorMsg || "Transaction details unavailable"}</p>
                    </main>
                </div>
            </div>
        );
    }

    const role = getOrderParticipantRole(order, currentUser.userId);
    const isBuyer = role === "buyer";
    const isSeller = role === "seller";

    if (!role) {
        return (
            <div className="flex h-screen w-full overflow-hidden bg-[#081521]">
                <Aside />
                <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                    <Header description="trading floor" title="p2p marketplace" />
                    <main id="main-content" tabIndex={-1} className="flex flex-col items-center justify-center flex-1 bg-[#081521]">
                        <Ban className="w-12 h-12 text-red-500 mb-2" />
                        <p className="text-white text-lg font-bold font-space">You are not authorized to view this trade.</p>
                    </main>
                </div>
            </div>
        );
    }

    const amountVal = parseFloat(order.assetAmount) || 0;
    const priceVal = parseFloat(order.offer?.price || "0") || 0;
    const totalVal = parseFloat(order.fiatAmount) || (amountVal * priceVal);
    
    const paymentMethodObj = order.offer?.payment_methods?.[0] || order.offer?.paymentMethods?.[0];
    
    let paymentType: "platform" | "web" | "bank" = "bank";
    const typeStr = (paymentMethodObj?.payment_provider?.type || paymentMethodObj?.type || "bank").toLowerCase();
    if (typeStr.includes("platform") || typeStr.includes("internal")) {
        paymentType = "platform";
    } else if (typeStr.includes("web") || typeStr.includes("wallet") || typeStr.includes("online")) {
        paymentType = "web";
    } else {
        paymentType = "bank";
    }

    const paymentMethodLabel = paymentMethodObj?.payment_provider?.name || paymentMethodObj?.bankName || "";
    
    const accountIdentifier = 
        paymentMethodObj?.accountIdentifier || 
        paymentMethodObj?.account_identifier || 
        paymentMethodObj?.accountDetails || 
        "";
        
    const accountOwner = 
        paymentMethodObj?.beneficiaryName || 
        paymentMethodObj?.beneficiary_name || 
        "";
    const paymentInstructionsAvailable = Boolean(
        paymentMethodLabel && (paymentType !== "bank" || (accountIdentifier && accountOwner))
    );

    const escrowId = order.escrow?.escrowId;
    const escrowStatus = order.escrow?.escrowStatus || "pending";
    const statusPresentation = getEscrowStatusPresentation(escrowStatus, role);
    const buyerAddress = order.escrow?.buyerAddress || order.buyer?.publicKey;
    const sellerAddress = order.escrow?.sellerAddress || order.seller?.publicKey;
    const counterpartyUser = isBuyer ? order.seller : order.buyer;
    const isCompleted = order.escrow?.escrowStatus === 'released';
    const canCancel = canCancelOrder(order, currentUser.userId);

    return (
        <div className="flex min-h-screen w-full overflow-hidden bg-[#081521] pb-20 md:pb-0">
            <Aside />
            <div className="flex flex-col flex-1 min-w-0 h-full overflow-hidden">
                <Header description="trading floor" title="p2p marketplace" />
                {isDemoOrder && (
                    <div role="status" className="border-b border-amber-400/30 bg-amber-400/10 px-4 py-2 text-center text-sm font-semibold text-amber-100">
                        Demo mode — simulated order only. No real Stellar or fiat transfer will occur.
                    </div>
                )}
                <main id="main-content" tabIndex={-1} className="flex flex-col md:flex-row items-start w-full h-auto min-h-[calc(100vh-96px)] md:h-[calc(100vh-96px)] overflow-y-auto md:overflow-hidden bg-[#081521] min-h-0 select-none">
                    
                    {/* COLUMNA IZQUIERDA: Panel de Transacción */}
                    <div className="w-full md:w-[1172px] h-auto md:h-full flex flex-col border-r border-[rgba(69,73,50,0.1)] bg-[#081521] md:shrink-0 min-h-0">
                        
                        {/* Subheader superior de navegación */}
                        <div className="h-[64px] border-b border-[rgba(69,73,50,0.1)] bg-[rgba(19,19,24,0.6)] backdrop-blur-md px-4 md:px-[60px] flex items-center justify-between shrink-0">
                            <Link 
                                href="/p2p/orders"
                                className="text-[#9CA3AF] hover:text-white flex items-center gap-2 text-[14px] font-bold uppercase tracking-[-0.35px] transition-colors cursor-pointer font-space"
                            >
                                <ArrowLeft className="w-4 h-4 text-[#9CA3AF] stroke-[3px]" /> BACK TO ORDERS
                            </Link>
                            <div className="flex items-center gap-3 select-none">
                                <span className={`w-2 h-2 rounded-full ${isCompleted ? "bg-[#55D6BE]" : "bg-[#55D6BE] animate-pulse"}`} />
                                <span className="text-[#55D6BE] text-[12px] font-bold tracking-[2.4px] uppercase font-space" aria-label={`${statusPresentation.label}. ${statusPresentation.action}`}>
                                    {statusPresentation.label}
                                </span>
                                {syncState.status === "reconnecting" && (
                                    <span className="flex items-center gap-1 text-[#9CA3AF] text-[10px] font-medium uppercase tracking-wider font-space">
                                        <RefreshCw className="w-3 h-3 animate-spin" />
                                        Reconnecting
                                    </span>
                                )}
                                {syncState.status === "error" && (
                                    <span className="flex items-center gap-1 text-red-400 text-[10px] font-medium uppercase tracking-wider font-space">
                                        Sync issue — will retry
                                    </span>
                                )}
{order?.escrow?.escrowId && !isCompleted && (
                                    <button
                                        type="button"
                                        onClick={refresh}
                                        disabled={syncState.status === "syncing"}
                                        aria-label="Refresh escrow status"
                                        className="flex items-center gap-1 text-[#9CA3AF] hover:text-[#55D6BE] text-[10px] font-medium disabled:opacity-50"
                                    >
                                        <RefreshCw className="w-3 h-3" /> Refresh status
                                    </button>
                                )}
                                {expiry.hasExpiry && (
                                    <span
                                        role="timer"
                                        aria-label={`Order ${expiry.label.toLowerCase()}`}
                                        className={`text-[11px] font-bold uppercase tracking-wider font-space ${expiry.isExpired ? "text-red-400" : "text-[#C2C7D0]"}`}
                                    >
                                        {expiry.isExpired ? "EXPIRED" : `${expiry.label} REMAINING`}
                                    </span>
                                )}              )}
                            </div>
                            <div className="flex items-center gap-4">
                                <h2 className="text-white font-black text-[20px] leading-7 uppercase tracking-normal font-space hidden md:block">
                                    ORDER DETAILS
                                </h2>
                            </div>
                        </div>

                        {order?.escrow?.escrowId && (
                            <p className="px-4 md:px-[60px] pb-2 text-[#9CA3AF] text-[11px]" aria-live="polite">
                                Status source: {syncState.source === "websocket" ? "live connection" : syncState.source === "polling" ? "periodic refresh" : "waiting for update"}
                                {syncState.lastUpdated && ` · Last updated ${new Date(syncState.lastUpdated).toLocaleString()}`}
                            </p>
                        )}

                        {/* Contenedor Principal Escalado por Rol */}
                        <div className="grow flex flex-col p-4 md:p-[32px_64px_40px_64px] overflow-visible md:overflow-auto justify-between items-center min-h-0 w-full">
                            <OrderStatusTimeline status={escrowStatus} role={role} />
                            <OrderStatusHistory orderId={order.orderId} />
                            
                            {isBuyer ? (
                                <div className="flex flex-col items-center justify-center md:h-full w-full">
                                    <div className="flex flex-col md:flex-row items-start gap-4 shrink-0 min-h-0 w-full">
                                        <div className="w-full md:w-[616.2px] h-full shrink-0">
                                            <TradeDetails 
                                                role={role}
                                                amount={totalVal}
                                                assetCode={order.offer?.assetCode || "USDC"}
                                                unitPrice={priceVal}
                                                total={totalVal}
                                                paymentMethod={paymentMethodLabel}
                                                paymentType={paymentType}
                                                accountIdentifier={accountIdentifier}
                                                accountOwner={accountOwner}
                                                paymentInstructionsAvailable={paymentInstructionsAvailable}
                                                counterpartyName={counterpartyUser?.alias || "Seller"}
                                                counterpartyRate="99.8%"
                                                counterpartyKyc={counterpartyUser?.kycStatus === "approved"}
                                                counterpartyProfileImageUrl={counterpartyUser?.profileImageUrl}
                                            />
                                        </div>
                                        <div className="w-full md:w-[402.8px] h-full shrink-0">
                                            <TradeEvidenceUploader 
                                                orderId={order.orderId}
                                                escrowId={escrowId}
                                                escrowStatus={escrowStatus}
                                                buyerAddress={buyerAddress}
                                                amount={amountVal}
                                                paymentInstructionsAvailable={paymentInstructionsAvailable}
                                                currency={order.seller?.preferredCurrency || "USD"}
                                                recipientName={accountOwner}
                                                isBuyer={isBuyer}
                                                evidenceUrl={order.escrow?.evidenceUrl}
                                                onStatusChange={fetchOrder}
                                                refreshStatus={refresh}
                                                canCancel={canCancel && !expiry.isExpired}
                                                isCancelling={isCancelling}
                                                onCancelOrder={() => setShowCancelModal(true)}
                                                isExpired={expiry.isExpired}
                                            />
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-6 w-full h-full items-center justify-center">
                                    
                                    {!isCompleted && (
                                        <div role="status" aria-live="polite" className="w-full bg-[rgba(26,27,33,0.7)] border border-[rgba(218,255,0,0.15)] rounded-[12px] p-4 md:p-[18px_28px] flex flex-col md:flex-row items-center justify-between shrink-0 gap-2">
                                            <div className="flex flex-col gap-1">
                                                <div className="flex items-center gap-2">
                                                    <span className="w-2 h-2 rounded-full bg-[#55D6BE] shadow-[0_0_6px_#55D6BE]" />
                                                    <span className="text-[#55D6BE] font-black text-[15px] tracking-[1.5px] uppercase font-space">
                                                        AWAITING BUYER PAYMENT
                                                    </span>
                                                </div>
                                                <span className="text-[#9CA3AF] text-[13px] font-space font-medium uppercase tracking-wider">
                                                    Order #{order.orderId?.split("-")[0]?.toUpperCase() || "P2P-B829"}
                                                </span>
                                            </div>
                                            <div className="flex flex-col items-end justify-center">
                                                <span className="text-white font-black text-[18px] font-space leading-none tracking-wide">
                                                    {expiry.hasExpiry ? expiry.label : "—"}
                                                </span>
                                                <span className="text-[#9CA3AF] text-[10px] font-bold uppercase tracking-[1px] font-space mt-1">
                                                    {expiry.hasExpiry ? (expiry.isExpired ? "ORDER EXPIRED" : "REMAINING TIME") : "EXPIRY UNAVAILABLE"}
                                                </span>
                                            </div>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full">
                                        <TradeDetails 
                                            role={role}
                                            amount={amountVal}
                                            assetCode={order.offer?.assetCode || "USDC"}
                                            unitPrice={priceVal}
                                            total={totalVal}
                                            paymentMethod={paymentMethodLabel}
                                            paymentType={paymentType}
                                            accountIdentifier={accountIdentifier}
                                            accountOwner={accountOwner}
                                            counterpartyName={counterpartyUser?.alias || "Buyer"}
                                            counterpartyRate="95.5%"
                                            counterpartyKyc={counterpartyUser?.kycStatus === "approved"}
                                        />
                                        <EvidencePreview 
                                            orderId={order.orderId}
                                            escrowId={escrowId}
                                            escrowStatus={escrowStatus}
                                            sellerAddress={sellerAddress}
                                            amount={amountVal}
                                            expiresAt={order.expiresAt as string | undefined}
                                            evidenceUrl={order.escrow?.evidenceUrl}
                                            onStatusChange={fetchOrder}
                                            refreshStatus={refresh}
                                            canCancel={canCancel && !expiry.isExpired}
                                            isCancelling={isCancelling}
                                            onCancelOrder={() => setShowCancelModal(true)}
                                            orderExpired={expiry.isExpired}
                                        />
                                    </div>

                                    <div className="w-full bg-[#191A1E] rounded-xl p-5 flex flex-col gap-1 shrink-0">
                                        <div className="flex items-center gap-2">
                                            <AlertTriangle className="w-5 h-5 text-[#ff8800]" />
                                            <span className="text-white font-bold text-[15px] font-space uppercase tracking-wide">
                                                Do not release crypto before verifying funds
                                            </span>
                                        </div>
                                        <p className="text-[#C2C7D0] text-[14px] font-space">
                                             Ensure the buyer&apos;s name on the bank transfer matches their verified profile name (
                                            <span className="font-bold text-white">{order.buyer?.alias || "Buyer"}</span>
                                            ). Third-party payments are against our terms of service.
                                        </p>
                                    </div>
                                    {!isCompleted && escrowStatus !== "disputed" && escrowStatus !== "resolved" && <div className="w-full flex flex-row items-center justify-end pt-2 shrink-0">
                                        <button type="button" onClick={() => setShowDisputeDialog(true)} className="text-[#FF6B6B] hover:text-red-400 font-bold font-space uppercase text-[14px] tracking-[0.5px] transition-colors cursor-pointer">Open dispute</button>
                                    </div>}

                                </div>
                            )}
                            <EscrowTransactionLinks
                                txHashLock={order.escrow?.txHashLock}
                                txHashRelease={order.escrow?.txHashRelease}
                            />
                            <OnChainEscrowDetails
                                escrowId={escrowId}
                                expectedAmount={order.assetAmount}
                                assetCode={order.offer?.assetCode || "USDC"}
                            />
                        </div>
                    </div>

                    {/* COLUMNA DERECHA: Componente de Chat global */}
                    <div className="w-full md:w-[460px] h-[min(65vh,560px)] min-h-[400px] md:h-full bg-[#0D1D2C] flex flex-col md:shrink-0 min-h-0">
                        <Chat 
                            orderId={order.orderId} 
                            chatName={counterpartyUser?.alias || (isBuyer ? "Seller" : "Buyer")} 
                            counterpartyProfileImageUrl={counterpartyUser?.profileImageUrl}
                        />
                        <TradeSafetyControls orderId={order.orderId} counterpartyId={counterpartyUser?.userId || ""} />
                    </div>
                </main>
            </div>
            {showDisputeDialog && <DisputeDialog orderId={order.orderId} onClose={() => setShowDisputeDialog(false)} onSubmitted={() => { notify("success", "Dispute sent to support. Escrow remains pending operator review."); void fetchOrder(); }} />}

            {showCancelModal && (
                <CancelOrderModal
                    onConfirm={handleCancelOrder}
                    onClose={() => setShowCancelModal(false)}
                    isCancelling={isCancelling}
                    canCancel={canCancel}
                />
            )}
        </div>
    );
}
