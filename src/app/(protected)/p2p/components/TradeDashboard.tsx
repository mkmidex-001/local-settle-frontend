"use client";

import { useEffect, useMemo, useState } from "react";
import { Suspense } from "react";
import dynamic from "next/dynamic";
const CreateOfferModal = dynamic(() => import("./CreateOfferModal").then((mod) => mod.CreateOfferModal), { ssr: false });
const ConfirmOrderModal = dynamic(() => import("./ConfirmOrderModal").then((mod) => mod.ConfirmOrderModal), { ssr: false });
import { EditOfferDialog } from "./EditOfferDialog";
import { useOffers } from "@/features/offer/hooks/useOffers";
import { useOfferFilters } from "@/features/offer/hooks/useOfferFilters";
import { useUsers } from "@/features/user/hooks/useUsers";
import { useUser } from "@/features/user/presentation/context/UserContext";
import { KycBanner } from "@/app/components/KycBanner";
import { useWalletBalance } from "@/features/wallet/presentation/hooks/useWalletBalance";
import { Offer } from "@/features/offer/models/offer";
import { formatOfferPrice } from "@/features/offer/utils/format-offer-price";
import { OfferFilters } from "@/features/offer/components/OfferFilters";
import { buildOfferQuery } from "@/features/offer/utils/build-offer-query";
import { PaymentMethodOption } from "@/features/paymentMethod/models/paymentMethod";
import { getRovingFocusIndex } from "@/utils/keyboardNavigation";

const tradeTabs = ["Buy", "Sell"] as const;

// ----------------------------------------------------------
// Helper: resolve a payment method option to a display name
// ----------------------------------------------------------
function resolvePaymentMethodName(pm: PaymentMethodOption): string {
    return (
        pm.payment_provider?.name ||
        pm.paymentProvider?.name ||
        pm.bankName ||
        pm.type ||
        ""
    );
}

// ----------------------------------------------------------
// MerchantBalance sub-component
// ----------------------------------------------------------
function MerchantBalance({ publicKey, assetCode }: { publicKey?: string; assetCode?: string }) {
    const { balance, balances, isLoading } = useWalletBalance(publicKey || null);

    if (isLoading) return <span className="animate-pulse">...</span>;
    if (!publicKey) return <span>0.00</span>;

    const normalizedAssetCode = assetCode === "XLM" || assetCode === "native" ? "native" : assetCode;

    if (normalizedAssetCode === "native") {
        return <span>{balance || "0.00"}</span>;
    }

    const asset = balances.find(b => b.asset_code === normalizedAssetCode);
    if (!asset) return <span>0.00</span>;

    return <span>{parseFloat(asset.balance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>;
}

function CounterpartySummary({ user }: { user?: import("@/features/user/models/users").Users }) {
    const [stats, setStats] = useState<{ totalOrders: number; completedOrders: number } | null>(null);

    useEffect(() => {
        if (!user?.userId) return;
        const controller = new AbortController();
        fetch(`${process.env.NEXT_PUBLIC_API_URL}/orders/user-stats/${encodeURIComponent(user.userId)}`, { signal: controller.signal })
            .then(response => response.ok ? response.json() : null)
            .then(data => {
                if (data && Number.isFinite(data.completedOrders) && Number.isFinite(data.totalOrders)) {
                    setStats({ totalOrders: data.totalOrders, completedOrders: data.completedOrders });
                }
            })
            .catch(() => undefined);
        return () => controller.abort();
    }, [user?.userId]);

    const createdAt = user?.createdAt ? Date.parse(user.createdAt) : Number.NaN;
    const joinedLabel = Number.isFinite(createdAt)
        ? `Joined ${new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" }).format(createdAt)}`
        : null;

    return (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[#9BABB7] text-xs mt-0.5">
            <span>{stats ? `${stats.completedOrders} completed orders` : "Order history unavailable"}</span>
            {joinedLabel && <span aria-label={joinedLabel}>· {joinedLabel}</span>}
            {user?.kycStatus === "approved" && (
                <span className="text-[#55D6BE]" aria-label="Identity verified">Verified</span>
            )}
        </div>
    );
}

// ----------------------------------------------------------
// Sort helper (client-side, does not mutate original array)
// ----------------------------------------------------------
function sortOffers(offers: Offer[], sort: string): Offer[] {
    const arr = [...offers];
    const compareIds = (a: Offer, b: Offer) =>
        a.offerId < b.offerId ? -1 : a.offerId > b.offerId ? 1 : 0;
    const comparePrice = (direction: 1 | -1) => (a: Offer, b: Offer) => {
        const aPrice = Number.parseFloat(a.price);
        const bPrice = Number.parseFloat(b.price);
        const aValid = Number.isFinite(aPrice);
        const bValid = Number.isFinite(bPrice);
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid && aPrice !== bPrice) return (aPrice - bPrice) * direction;
        return compareIds(a, b);
    };
    switch (sort) {
        case "price_asc":
            return arr.sort(comparePrice(1));
        case "price_desc":
            return arr.sort(comparePrice(-1));
        case "newest":
            return arr.sort((a, b) => {
                const aDate = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
                const bDate = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
                const aValid = Number.isFinite(aDate);
                const bValid = Number.isFinite(bDate);
                if (aValid !== bValid) return aValid ? -1 : 1;
                if (aValid && aDate !== bDate) return bDate - aDate;
                return compareIds(a, b);
            });
        case "completion_rate_desc":
        case "best_match":
        default:
            return arr;
    }
}

function inactiveOfferReason(offer: Offer): string | null {
    if (offer.executed) return "This offer has already been completed.";
    switch (offer.status.toLowerCase()) {
        case "active": return null;
        case "paused": return "The owner has paused this offer.";
        case "closed": return "The owner has closed this offer.";
        case "expired": return "This offer has expired.";
        case "unavailable":
        case "inactive": return "This offer is currently unavailable.";
        default: return "This offer is not available for new trades.";
    }
}

// ----------------------------------------------------------
// Empty state component
// ----------------------------------------------------------
function EmptyState({ onClear, isFiltered }: { onClear: () => void; isFiltered: boolean }) {
    return (
        <div className="flex flex-col items-center justify-center py-24 gap-5 text-center">
            <div className="w-16 h-16 rounded-full bg-[#1a1a1c] border border-[#263949] flex items-center justify-center">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#4a4a4a" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.35-4.35" />
                    <path d="M11 8v6M8 11h6" />
                </svg>
            </div>
            <div className="flex flex-col gap-1.5">
                <p className="text-white font-bold text-base">
                    {isFiltered ? "No offers match your current filters." : "No offers available."}
                </p>
                <p className="text-[#6b7280] text-sm">
                    {isFiltered
                        ? "Try adjusting or clearing your filters to see more results."
                        : "Check back later or create your own offer."}
                </p>
            </div>
            {isFiltered && (
                <button
                    id="empty-state-clear-filters"
                    onClick={onClear}
                    className="px-5 py-2.5 rounded-xl border border-[#55D6BE]/40 text-[#55D6BE] text-sm font-bold
                               hover:bg-[#55D6BE]/10 transition-colors duration-200"
                >
                    Clear all filters
                </button>
            )}
        </div>
    );
}

// ----------------------------------------------------------
// Loading skeleton
// ----------------------------------------------------------
function OfferSkeleton() {
    return (
        <div className="flex flex-col xl:flex-row bg-[#0D1D2C] border border-[#263949] rounded-2xl p-6 gap-6 xl:gap-0 animate-pulse">
            <div className="flex flex-col gap-6 xl:w-[40%]">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-[#172B3A]" />
                    <div className="flex flex-col gap-2">
                        <div className="h-4 w-28 bg-[#172B3A] rounded" />
                        <div className="h-3 w-20 bg-[#172B3A] rounded" />
                    </div>
                </div>
                <div className="flex gap-12">
                    <div className="h-4 w-20 bg-[#172B3A] rounded" />
                    <div className="h-4 w-24 bg-[#172B3A] rounded" />
                </div>
            </div>
            <div className="flex flex-col gap-3 xl:w-[30%] xl:pl-8 justify-center">
                <div className="h-3 w-24 bg-[#172B3A] rounded" />
                <div className="h-4 w-20 bg-[#172B3A] rounded" />
            </div>
            <div className="flex flex-col items-end gap-5 xl:w-[30%] xl:pr-4 justify-center">
                <div className="h-8 w-32 bg-[#172B3A] rounded" />
                <div className="h-12 w-36 bg-[#172B3A] rounded-xl" />
            </div>
        </div>
    );
}

// ----------------------------------------------------------
// Inner dashboard (needs Suspense for useSearchParams)
// ----------------------------------------------------------
function TradeDashboardInner() {
    const [tab, setTab] = useState("Buy");
    const [page, setPage] = useState(0);
    const pageSize = 20;
    const [isOpen, setIsOpen] = useState(false);
    const [selectedOffer, setSelectedOffer] = useState<Offer | null>(null);
    const [editingOffer, setEditingOffer] = useState<Offer | null>(null);
    const [offerStatusOverrides, setOfferStatusOverrides] = useState<Record<string, string>>({});
    const [ownerPausedOffers, setOwnerPausedOffers] = useState<Record<string, Offer>>({});
    const [compareIds, setCompareIds] = useState<string[]>([]);

    const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
        const nextIndex = getRovingFocusIndex(event.key, index, tradeTabs.length, "horizontal");
        if (nextIndex === null) return;

        event.preventDefault();
        const nextTab = tradeTabs[nextIndex];
        setTab(nextTab);
        document.getElementById(`tab-${nextTab.toLowerCase()}`)?.focus();
    };

    // Filter state
    const {
        filters,
        draftFilters,
        errors,
        activeFilterCount,
        setFilter,
        setDraftFilter,
        applyDraftFilters,
        applyPreset,
        resetDraftFilters,
        clearFilters,
        isFiltersDefault,
    } = useOfferFilters();

    // Build query: type comes from the tab; the rest from active filters
    const apiFilters = useMemo(
        () => ({ ...buildOfferQuery(tab === "Buy" ? "sell" : "buy", filters), skip: String(page * pageSize), take: String(pageSize) }),
        [tab, filters, page]
    );

    const { offers, isLoading, isError, error, refetch, isFetching, updateOffer } = useOffers(apiFilters);
    const { currentUser } = useUser();

    useEffect(() => { setPage(0); }, [tab, filters]);

    // Start with non-executed offers (type + assetCode already filtered by backend).
    // paymentMethod, minAmount, maxAmount, and sort are applied here client-side
    // because the backend does not yet support those query params.
    const visibleOffers = useMemo(() => {
        const availableOffers = new Map(offers.map((offer) => [offer.offerId, offer]));
        for (const pausedOffer of Object.values(ownerPausedOffers)) {
            if (pausedOffer.creatorId === currentUser?.userId && !availableOffers.has(pausedOffer.offerId)) {
                availableOffers.set(pausedOffer.offerId, pausedOffer);
            }
        }
        let result = Array.from(availableOffers.values()).map((offer) => ({
            ...offer,
            status: offerStatusOverrides[offer.offerId] ?? offer.status,
        })).filter((offer) => !offer.executed && (offer.status !== "paused" || offer.creatorId === currentUser?.userId));

        // --- paymentMethod filter ---
        if (filters.paymentMethod) {
            result = result.filter(offer => {
                const pms = [
                    ...(offer.payment_methods || []),
                    ...(offer.paymentMethods || []),
                ];
                return pms.some(pm => {
                    const name = resolvePaymentMethodName(pm);
                    return name.toLowerCase() === filters.paymentMethod.toLowerCase();
                });
            });
        }

        // --- minAmount filter ---
        // "min amount" from the user's perspective means:
        // the offer's maxAmount must be >= the user's desired minimum
        // (i.e. the offer can accommodate at least that much)
        if (filters.minAmount && parseFloat(filters.minAmount) > 0) {
            const min = parseFloat(filters.minAmount);
            result = result.filter(o => parseFloat(o.maxAmount) >= min);
        }

        // --- maxAmount filter ---
        // the offer's minAmount must be <= the user's desired maximum
        // (i.e. the offer starts at or below the user's cap)
        if (filters.maxAmount && parseFloat(filters.maxAmount) > 0) {
            const max = parseFloat(filters.maxAmount);
            result = result.filter(o => parseFloat(o.minAmount) <= max);
        }

        if (filters.minPrice && parseFloat(filters.minPrice) > 0) {
            result = result.filter(o => parseFloat(o.price) >= parseFloat(filters.minPrice));
        }
        if (filters.maxPrice && parseFloat(filters.maxPrice) > 0) {
            result = result.filter(o => parseFloat(o.price) <= parseFloat(filters.maxPrice));
        }

        return sortOffers(result, filters.sort);
    }, [offers, ownerPausedOffers, offerStatusOverrides, currentUser?.userId, filters.paymentMethod, filters.minAmount, filters.maxAmount, filters.minPrice, filters.maxPrice, filters.sort]);

    // Derive available payment methods and assets from current offer set
    const availablePaymentMethods = useMemo(() => {
        const methods = new Set<string>();
        offers.forEach(offer => {
            const pms = [...(offer.payment_methods || []), ...(offer.paymentMethods || [])];
            pms.forEach(pm => {
                const name = resolvePaymentMethodName(pm);
                if (name) methods.add(name);
            });
        });
        return Array.from(methods).sort();
    }, [offers]);

    const availableAssets = useMemo(() => {
        const assets = new Set<string>();
        offers.forEach(offer => {
            if (offer.assetCode) assets.add(offer.assetCode);
        });
        return Array.from(assets).sort();
    }, [offers]);

    const { getUser, userFound } = useUsers();
    const isVerified = currentUser?.kycStatus === "approved";

    useEffect(() => {
        offers.forEach((offer) => {
            if (offer?.creatorId) {
                getUser(offer.creatorId);
            }
        });
    }, [offers, getUser]);

    const isFiltered = !isFiltersDefault;

    return (
        <div className="w-full flex flex-col pt-8 pb-12 px-1">
            <KycBanner />

            {/* Top toolbar: Tab switcher + Create button */}
            <div className="w-full mb-6 px-2">
                <div className="flex flex-col md:flex-row items-center justify-between mb-5 gap-4">
                    <div
                        role="tablist"
                        aria-label="Trade type"
                        className="flex bg-[#1a1a1a] rounded-xl p-1 w-full md:w-auto"
                    >
                        {tradeTabs.map((t, index) => (
                            <button
                                key={t}
                                id={`tab-${t.toLowerCase()}`}
                                type="button"
                                role="tab"
                                aria-selected={tab === t}
                                aria-controls={`offers-${t.toLowerCase()}-panel`}
                                tabIndex={tab === t ? 0 : -1}
                                onClick={() => setTab(t)}
                                onKeyDown={(event) => handleTabKeyDown(event, index)}
                                className={`flex-1 md:flex-none px-6 py-3 rounded-xl text-base font-bold transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE] focus-visible:ring-offset-2 focus-visible:ring-offset-[#1a1a1a]
                                ${tab === t
                                        ? "bg-[#263949] text-[#55D6BE]"
                                        : "text-[#6b7280] hover:text-white"
                                    }`}
                            >
                                {t}
                            </button>
                        ))}
                    </div>

                    <button
                        id="create-offer-btn"
                        onClick={() => {
                            if (!isVerified) {
                                alert("KYC verification required to create offers.");
                                return;
                            }
                            setIsOpen(true);
                        }}
                        disabled={!isVerified}
                        title={!isVerified ? "KYC verification required" : ""}
                        className={`flex items-center justify-center gap-2 text-base font-bold px-6 py-3 rounded-2xl transition-all duration-200 w-full md:w-auto ${isVerified
                            ? "bg-[#55D6BE] text-black hover:bg-[#55D6BE]"
                            : "bg-gray-700 text-gray-400 cursor-not-allowed"
                            }`}
                    >
                        <span className="text-lg leading-none">+</span>
                        Create Offer
                    </button>
                </div>

                {/* Filter bar */}
                <div className="bg-[#0f0f11] border border-[#263949] rounded-2xl p-4">
                    <OfferFilters
                        filters={filters}
                        draftFilters={draftFilters}
                        errors={errors}
                        activeFilterCount={activeFilterCount}
                        availablePaymentMethods={availablePaymentMethods}
                        availableAssets={availableAssets}
                        onFilterChange={setFilter}
                        onDraftFilterChange={setDraftFilter}
                        onApplyDraft={applyDraftFilters}
                        onApplyPreset={applyPreset}
                        onOpenDraft={resetDraftFilters}
                        onClearFilters={clearFilters}
                    />
                </div>
            </div>

            {/* Offer list */}
            <div
                id={`offers-${tab.toLowerCase()}-panel`}
                role="tabpanel"
                aria-labelledby={`tab-${tab.toLowerCase()}`}
                tabIndex={0}
                className="flex flex-col w-full px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE]"
            >
                {isLoading ? (
                    <div className="space-y-4">
                        {[1, 2, 3].map(i => <OfferSkeleton key={i} />)}
                    </div>
                ) : isError && offers.length === 0 ? (
                    <div role="alert" className="rounded-xl border border-red-500/30 bg-red-950/20 p-6 text-center text-white">
                        <p>Offers could not be loaded{error instanceof Error ? `: ${error.message}` : "."}</p>
                        <button type="button" onClick={() => refetch()} disabled={isFetching} className="mt-3 rounded-lg bg-[#55D6BE] px-4 py-2 font-semibold text-black disabled:opacity-60">
                            {isFetching ? "Retrying…" : "Try again"}
                        </button>
                    </div>
                ) : visibleOffers.length > 0 ? (
                    <div className="space-y-4">
                        {isError && <p role="status" className="text-amber-300">Could not refresh offers. Showing the last available results.</p>}
                        {visibleOffers.map((offer) => {
                            const paymentMethods = [
                                ...(offer.payment_methods || []),
                                ...(offer.paymentMethods || [])
                            ];

                            return (
                                <article
                                    key={offer.offerId}
                                    aria-labelledby={`offer-title-${offer.offerId}`}
                                    tabIndex={0}
                                    className="flex min-w-0 w-full flex-col xl:flex-row bg-[#0D1D2C] border border-[#263949] rounded-2xl p-4 sm:p-6 hover:border-[#55D6BE] hover:bg-[#1A1A1C] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE] transition-all duration-300 group gap-6 xl:gap-0"
                                >
                                    {/* Left: Identity and Capacity */}
                                    <div className="flex flex-col gap-6 xl:w-[40%]">
                                        {/* Identity */}
                                        <div className="flex items-center gap-3">
                                            <div className="relative">
                                                <div className="w-12 h-12 rounded-full bg-[#263949] overflow-hidden flex items-center justify-center text-[#6b7280] text-xl">
                                                    {userFound[offer.creatorId]?.profileImageUrl ? (
                                                        <img src={userFound[offer.creatorId].profileImageUrl} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        "👤"
                                                    )}
                                                </div>
                                                <div className="absolute bottom-0 right-0 w-3.5 h-3.5 bg-[#55D6BE] border-2 border-[#0D1D2C] rounded-full"></div>
                                            </div>
                                            <div className="flex flex-col">
                                                <h3 id={`offer-title-${offer.offerId}`} className="text-white font-bold text-base">Offer from {userFound[offer.creatorId]?.alias || "Unknown"}</h3>
                                                <CounterpartySummary user={userFound[offer.creatorId]} />
                                            </div>
                                        </div>

                                        {/* Capacity */}
                                        <div className="flex flex-wrap gap-x-8 gap-y-4">
                                            <div className="flex flex-col gap-1.5">
                                                <span className="text-[#9BABB7] text-[10px] font-bold tracking-widest uppercase">Available</span>
                                                <span className="min-w-0 break-words text-white font-bold text-sm"><MerchantBalance publicKey={userFound[offer.creatorId]?.publicKey} assetCode={offer.assetCode} /> {offer.assetCode || "BTC"}</span>
                                            </div>
                                            <div className="flex flex-col gap-1.5">
                                                <span className="text-[#9BABB7] text-[10px] font-bold tracking-widest uppercase">Limits</span>
                                                <span className="min-w-0 break-words text-white font-bold text-sm">${offer.minAmount} - ${offer.maxAmount}</span>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Center: Payment Methods */}
                                    <div className="flex flex-col gap-4 xl:w-[30%] xl:border-l border-[#263949] xl:pl-8 justify-center">
                                        <span className="text-[#A1969C] text-[10px] font-bold tracking-widest uppercase">Payment Methods</span>
                                        <div className="flex flex-col gap-2.5">
                                            {paymentMethods.length > 0 ? (
                                                paymentMethods.slice(0, 3).map((pm, i) => (
                                                    <span key={i} className="break-words text-white font-bold text-sm uppercase tracking-wide">
                                                        {typeof pm === 'string' ? pm : resolvePaymentMethodName(pm)}
                                                    </span>
                                                ))
                                            ) : (
                                                <span className="text-white font-bold text-sm uppercase tracking-wide">WIRE</span>
                                            )}
                                            {paymentMethods.length > 3 && (
                                                <span className="text-[#9BABB7] font-bold text-xs uppercase tracking-wide">+{paymentMethods.length - 3} MORE</span>
                                            )}
                                        </div>
                                    </div>

                                    {/* Right: Price + CTA */}
                                    <div className="flex flex-col items-start xl:items-end gap-5 xl:w-[30%] xl:border-l border-[#263949] xl:pr-4 justify-center">
                                        <div className="flex flex-col items-start xl:items-end gap-1.5">
                                            <span className="text-[#A1969C] text-[10px] font-bold tracking-widest uppercase">Unit Price</span>
                                            <div className="flex items-baseline gap-1.5">
                                                <span className="text-[#55D6BE] font-bold text-[32px] tabular-nums tracking-tight leading-none">
                                                    {formatOfferPrice(offer.price, offer.fiatCurrency ?? offer.currency)}
                                                </span>
                                            </div>
                                        </div>
<button
                                            type="button"
                                            aria-pressed={compareIds.includes(offer.offerId)}
                                            onClick={() => setCompareIds((ids) => ids.includes(offer.offerId)
                                                ? ids.filter((id) => id !== offer.offerId)
                                                : ids.length < 3 ? [...ids, offer.offerId] : ids)}
                                            className="text-xs text-[#55D6BE] underline underline-offset-2"
                                        >
                                            {compareIds.includes(offer.offerId) ? "Remove from comparison" : "Compare offer"}
                                        </button>
                                        {currentUser?.userId === offer.creatorId && (
                                            <>
                                                <span className="mb-2 rounded-full border border-[#55D6BE]/40 px-3 py-1 text-xs text-[#55D6BE]">Your offer</span>
                                                <button type="button" onClick={() => setEditingOffer(offer)} className="rounded-lg border border-[#52616d] px-3 py-2 text-xs font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE]">Edit</button>
                                            </>
                                        )}
                                        {inactiveOfferReason(offer) ? (
                                            <p role="status" className="w-full max-w-[220px] rounded-lg border border-amber-500/30 bg-amber-950/20 p-3 text-xs text-amber-200">
                                                {inactiveOfferReason(offer)}
                                            </p>
                                        ) : currentUser?.userId !== offer.creatorId && <button
                                            disabled={!isVerified}
                                            onClick={() => {
                                                if (!isVerified) {
                                                    alert("KYC verification required to trade.");
                                                    return;
                                                }
                                                setSelectedOffer(offer);
                                            }}
                                            aria-label={`${tab === "Buy" ? "Buy from" : "Sell to"} ${userFound[offer.creatorId]?.alias || "this trader"}`}
                                            className={`w-full max-w-[220px] py-3.5 rounded-xl font-bold text-sm tracking-wide transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE] focus-visible:ring-offset-2 focus-visible:ring-offset-[#0D1D2C] ${isVerified
                                                ? "bg-[#55D6BE] text-black hover:shadow-[0_0_20px_rgba(85,214,190,0.25)] hover:scale-[1.02] active:scale-[0.98]"
                                                : "bg-gray-700 text-gray-400 cursor-not-allowed"
                                                }`}
                                        >
                                            {tab === "Buy" ? "BUY" : "SELL"}
                                        </button>}
                                        {currentUser?.userId === offer.creatorId && (
                                            <button
                                                type="button"
                                                onClick={async () => {
                                                    const nextStatus = offer.status === "paused" ? "active" : "paused";
                                                    setOfferStatusOverrides((previous) => ({ ...previous, [offer.offerId]: nextStatus }));
                                                    if (nextStatus === "paused") setOwnerPausedOffers((previous) => ({ ...previous, [offer.offerId]: { ...offer, status: "paused" } }));
                                                    try {
                                                        await updateOffer(offer.offerId, { status: nextStatus });
                                                        if (nextStatus === "active") setOwnerPausedOffers((previous) => {
                                                            const next = { ...previous };
                                                            delete next[offer.offerId];
                                                            return next;
                                                        });
                                                    } catch (error) {
                                                        setOfferStatusOverrides((previous) => {
                                                            const next = { ...previous };
                                                            delete next[offer.offerId];
                                                            return next;
                                                        });
                                                        if (offer.status !== "paused") setOwnerPausedOffers((previous) => {
                                                            const next = { ...previous };
                                                            delete next[offer.offerId];
                                                            return next;
                                                        });
                                                        alert(error instanceof Error ? error.message : "Offer status could not be updated.");
                                                    }
                                                }}
                                                className="w-full max-w-[220px] rounded-lg border border-[#55D6BE]/40 px-4 py-2 text-xs font-bold text-[#55D6BE] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#55D6BE]"
                                            >
                                                {offer.status === "paused" ? "Resume offer" : "Pause offer"}
                                            </button>
                                        )}
                                    </div>
                                </article>
                            );
                        })}
                    </div>
                ) : (
                    <EmptyState onClear={clearFilters} isFiltered={isFiltered} />
                )}
            </div>

            {compareIds.length > 0 && (
                <section className="mt-6 overflow-x-auto rounded-xl border border-[#263949] bg-[#0D1D2C] p-4" aria-label="Offer comparison">
                    <h2 className="mb-3 text-sm font-bold text-white">Compare offers ({compareIds.length}/3)</h2>
                    <table className="w-full min-w-[560px] text-left text-sm text-white">
                        <thead><tr className="text-gray-400"><th className="p-2">Offer</th><th className="p-2">Price</th><th className="p-2">Limits</th><th className="p-2">Payment methods</th></tr></thead>
                        <tbody>{offers.filter((offer) => compareIds.includes(offer.offerId)).map((offer) => (
                            <tr key={offer.offerId} className="border-t border-[#263949]">
                                <td className="p-2">{offer.assetCode} {offer.type}</td>
                                <td className="p-2">{offer.price} USD</td>
                                <td className="p-2">{offer.minAmount}–{offer.maxAmount} {offer.assetCode}</td>
                                <td className="p-2">{[...(offer.payment_methods || []), ...(offer.paymentMethods || [])].map(resolvePaymentMethodName).filter(Boolean).join(", ") || "Not specified"}</td>
                            </tr>
                        ))}</tbody>
                    </table>
                </section>
            )}
            <nav className="mt-6 flex items-center justify-center gap-4" aria-label="Marketplace pages">
                <button type="button" onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0 || isLoading} className="rounded-lg border border-[#263949] px-4 py-2 text-sm text-white disabled:opacity-40">Previous</button>
                <span className="text-sm text-gray-400" aria-live="polite">Page {page + 1}</span>
                <button type="button" onClick={() => setPage((current) => current + 1)} disabled={isLoading || offers.length < pageSize} className="rounded-lg border border-[#263949] px-4 py-2 text-sm text-white disabled:opacity-40">Next</button>
            </nav>

            {isOpen && (
                <CreateOfferModal onClose={() => setIsOpen(false)} />
            )}

            {editingOffer && <EditOfferDialog offer={editingOffer} onSave={(update) => updateOffer(editingOffer.offerId, update)} onClose={() => setEditingOffer(null)} />}
            {selectedOffer && userFound[selectedOffer.creatorId] && (
                <ConfirmOrderModal
                    offer={selectedOffer}
                    creator={userFound[selectedOffer.creatorId]}
                    onClose={() => setSelectedOffer(null)}
                />
            )}
        </div>
    );
}

// ----------------------------------------------------------
// Exported wrapper — Suspense required because useSearchParams
// can only be called inside a Suspense boundary in Next.js App Router.
// ----------------------------------------------------------
export function TradeDashboard() {
    return (
        <Suspense fallback={
            <div className="w-full flex flex-col pt-8 pb-12 px-1 space-y-4">
                {[1, 2, 3].map(i => (
                    <div key={i} className="h-36 bg-[#0D1D2C] border border-[#263949] rounded-2xl animate-pulse" />
                ))}
            </div>
        }>
            <TradeDashboardInner />
        </Suspense>
    );
}
