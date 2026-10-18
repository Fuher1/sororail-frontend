// ---- src/clients/base.d.ts ----
import { Contract, rpc, type Transaction, type xdr } from "@stellar/stellar-sdk";
import type { Signer } from "../signers/index.js";
/** Connection and contract details every client needs. */
export interface ClientOptions {
    /** The deployed contract address (`C...`). */
    contractId: string;
    /** Soroban RPC endpoint. */
    rpcUrl: string;
    /** Network passphrase, e.g. `Networks.TESTNET`. */
    networkPassphrase: string;
    /**
     * Account that builds and simulates calls. Required for anything that
     * touches the network; the signer's key is the usual choice.
     */
    publicKey?: string;
    /**
     * Inclusion fee in stroops. Defaults to `BASE_FEE`.
     *
     * The fee is deducted from the account's balance for each transaction built
     * and submitted, even if the transaction later fails. Choose a fee that
     * reflects the current network congestion to avoid overpaying or timing out.
     */
    fee?: string;
    /** Transaction validity window in seconds. Defaults to 30. */
    timeoutSeconds?: number;
    /**
     * Maximum number of poll attempts when waiting for transaction confirmation.
     * Defaults to 30.
     */
    pollAttempts?: number;
    /**
     * Interval in milliseconds between poll attempts for transaction confirmation.
     * Defaults to 1000.
     */
    pollIntervalMs?: number;
    /**
     * Allow plain HTTP connections. Only for a local quickstart node.
     *
     * ⚠️ **Security warning**: Enabling this for a remote RPC URL sends
     * unsigned/simulated transaction data over plaintext HTTP. This exposes
     * contract calls, amounts, recipient addresses, and account state to
     * network eavesdropping. Use only with local nodes where the RPC connection
     * does not cross untrusted networks. For remote RPC endpoints, always use
     * HTTPS (the default; this must remain `false`).
     */
    allowHttp?: boolean;
}
/** A submitted transaction and its decoded return value. */
export interface SentCall<T> {
    /** Transaction hash, for a block explorer link. */
    hash: string;
    /** The contract's return value, decoded. */
    result: T;
}
/**
 * The resource footprint from a simulation, useful for showing estimated
 * network fees before signing.
 */
export interface SimulatedResources {
    /** The simulated resource fee in stroops. */
    resourceFee: bigint;
    /** The minimum resource fee required. */
    minResourceFee: bigint;
    /** The storage footprint, if present. */
    footprint?: xdr.LedgerFootprint;
}
/**
 * A built, unsent contract call.
 *
 * The stages are deliberately separate — build, simulate, sign, send, confirm
 * — so a caller can inspect exactly what a transaction will do before asking
 * anyone to sign it. That is what makes a confirmation screen honest, so
 * nothing here collapses the steps behind a single "just do it" call.
 */
export declare class PreparedCall<T> {
    #private;
    constructor(args: {
        server: rpc.Server;
        built: Transaction;
        parse: (value: unknown) => T;
        networkPassphrase: string;
        pollAttempts?: number;
        pollIntervalMs?: number;
    });
    /** The unsigned transaction, as base64 XDR. */
    toXDR(): string;
    /**
     * Runs the call without submitting it, returning what it would produce.
     *
     * This is how read-only methods are called, and how a write should be
     * previewed: a simulation that fails tells you the write would fail, before
     * a signature is requested and before any fee is spent.
     */
    simulate(options?: {
        signal?: AbortSignal;
    }): Promise<T>;
    /**
     * Simulates and returns the full resource footprint alongside the decoded
     * return value. Useful for showing "estimated network fee" in a
     * confirmation dialog before asking the user to sign.
     */
    simulateWithResources(options?: {
        signal?: AbortSignal;
    }): Promise<{
        result: T;
        resources: SimulatedResources;
    }>;
    /**
     * Simulates, asks the signer to sign, submits, and waits for the result.
     *
     * The simulation runs first so that a doomed transaction is rejected before
     * the user is prompted.
     */
    signAndSend(signer: Signer, options?: {
        signal?: AbortSignal;
    }): Promise<SentCall<T>>;
}
/** Shared plumbing for the per-contract clients. */
export declare abstract class BaseClient {
    #private;
    protected readonly server: rpc.Server;
    protected readonly contract: Contract;
    protected readonly options: ClientOptions;
    /** Accounts are cached for 5 seconds to amortise batch prepare calls. */
    static readonly ACCOUNT_CACHE_TTL_MS = 5000;
    constructor(options: ClientOptions);
    /** The deployed contract address this client talks to. */
    get contractId(): string;
    /**
     * Clears the account sequence number cache. Call after a failed transaction
     * submission to avoid reusing a stale sequence number.
     */
    clearAccountCache(): void;
    /** Builds a call without simulating or sending it. */
    protected prepare<T>(method: string, args: xdr.ScVal[], parse: (value: unknown) => T): Promise<PreparedCall<T>>;
    /** Builds a call and simulates it immediately. For read-only methods. */
    protected read<T>(method: string, args: xdr.ScVal[], parse: (value: unknown) => T): Promise<T>;
}

// ---- src/clients/batchPayout.d.ts ----
import type { Payment, Receipt } from "../types/index.js";
import { BaseClient, type PreparedCall } from "./base.js";
/**
 * Batch payout: one transaction, many recipients.
 *
 * **Stateless and reusable.** Unlike the other contracts, this one holds no
 * position and no funds, so a single deployed address serves everybody.
 *
 * **All-or-nothing.** If any transfer fails, the whole batch reverts and
 * nobody is paid. Check {@link BatchPayoutClient.maxRecipients} and split
 * larger payrolls client-side; duplicates are allowed on-chain, so catch those
 * in your CSV import if you do not want them.
 */
export declare class BatchPayoutClient extends BaseClient {
    /** Pays each recipient their own amount. */
    execute(args: {
        funder: string;
        token: string;
        recipients: readonly Payment[];
    }): Promise<PreparedCall<Receipt>>;
    /**
     * Pays every recipient the same amount.
     *
     * Cheaper to submit than {@link BatchPayoutClient.execute} because the
     * amount crosses the wire once rather than once per line.
     */
    executeEqual(args: {
        funder: string;
        token: string;
        recipients: readonly string[];
        amountEach: bigint;
    }): Promise<PreparedCall<Receipt>>;
    /**
     * Totals and validates a batch without moving anything.
     *
     * Runs exactly the checks `execute` does, so a preview that succeeds means
     * the batch will not be rejected for size, an invalid amount, or an
     * overflowing total. Show this before asking for a signature.
     */
    preview(recipients: readonly Payment[]): Promise<Receipt>;
    /**
     * The maximum recipients one batch may contain.
     *
     * Read it rather than hardcoding: the contract's cap is derived from network
     * resource limits and may change between deployments.
     */
    maxRecipients(): Promise<number>;
    /** Splits an oversized payroll into batches this contract will accept. */
    static chunk(recipients: readonly Payment[], maxRecipients: number): Payment[][];
}

// ---- src/clients/escrow.d.ts ----
import { type Escrow, type EscrowStateName } from "../types/index.js";
import { BaseClient, type PreparedCall } from "./base.js";
/**
 * Escrow: funds held by the contract, released on a condition.
 *
 * One agreement per deployed contract. `init` claims the instance
 * permanently — a second call fails with `AlreadyInitialized` — so deploy one
 * contract per escrow rather than reusing an address.
 */
export declare class EscrowClient extends BaseClient {
    /**
     * Configures the escrow. Requires the depositor's signature: `init` decides
     * whose funds `fund` will later pull.
     *
     * `deadline` is a ledger timestamp in seconds and must be in the future.
     */
    init(args: {
        depositor: string;
        beneficiary: string;
        /** Optional. Without one, `dispute` and `resolve` are unavailable. */
        arbiter?: string | null;
        token: string;
        amount: bigint;
        deadline: bigint;
    }): Promise<PreparedCall<void>>;
    /** Pulls the agreed amount from the depositor into the contract. */
    fund(): Promise<PreparedCall<void>>;
    /**
     * Pays the beneficiary. Callable by the depositor or the arbiter — never by
     * the beneficiary, which is the point of the escrow.
     */
    release(): Promise<PreparedCall<void>>;
    /**
     * Returns the funds to the depositor.
     *
     * The depositor may only do this once the deadline has passed; the arbiter
     * may do it at any time.
     */
    refund(): Promise<PreparedCall<void>>;
    /** Freezes the escrow pending an arbiter decision. Either party may call. */
    dispute(): Promise<PreparedCall<void>>;
    /**
     * Splits the funds. Arbiter only.
     *
     * @param splitBps The beneficiary's share in basis points, 0–10000. The
     *   depositor receives the remainder, computed by subtraction so the two
     *   payments always sum to exactly the escrowed amount.
     */
    resolve(splitBps: number): Promise<PreparedCall<void>>;
    /** The current lifecycle position. */
    state(): Promise<EscrowStateName>;
    /** The full agreement. */
    get(): Promise<Escrow>;
}

// ---- src/clients/recurring.d.ts ----
import type { Authorization } from "../types/index.js";
import { BaseClient, type PreparedCall } from "./base.js";
/**
 * Recurring: pull-based authorization for subscriptions.
 *
 * **This contract never holds funds.** The payer grants it an allowance on the
 * token with `approve`, and each charge moves money straight from payer to
 * payee via `transfer_from`. Revoking that allowance on the token stops
 * charges immediately, with or without cancelling here — see
 * {@link RecurringClient.authorize}.
 *
 * **Skipped periods are forfeited, not banked.** The next charge is scheduled
 * at `now + periodSeconds` each time, so a payee who forgets to charge for
 * three months cannot then take three payments. Surface this in any UI: it is
 * a deliberate consumer-protection choice and it surprises merchants.
 */
export declare class RecurringClient extends BaseClient {
    /**
     * Records the authorization. Requires the payer's signature.
     *
     * The first charge becomes available one full period after this call.
     *
     * **This alone does not let the payee take anything.** The payer must also
     * `approve` this contract as a spender on the token, for at least the total
     * they intend to allow. That allowance is the real cap.
     */
    authorize(args: {
        payer: string;
        payee: string;
        token: string;
        amountPerPeriod: bigint;
        periodSeconds: bigint;
        /** Cap on the number of charges. Omit for open-ended. */
        maxPeriods?: number | null;
    }): Promise<PreparedCall<void>>;
    /**
     * Pulls one period's payment from payer to payee, returning the amount.
     * Callable by the payee.
     */
    charge(): Promise<PreparedCall<bigint>>;
    /** Cancels the authorization immediately. Either party may call. */
    cancel(): Promise<PreparedCall<void>>;
    /**
     * The earliest timestamp at which the next charge may be taken.
     *
     * Reports the stored schedule regardless of cancellation or exhaustion; use
     * {@link RecurringClient.isChargeable} for whether a charge would succeed.
     */
    nextChargeableAt(): Promise<bigint>;
    /** Whether a charge would succeed right now. */
    isChargeable(): Promise<boolean>;
    /** Charges still permitted under the cap, or `null` if open-ended. */
    remainingPeriods(): Promise<number | null>;
    /** The full authorization record. */
    get(): Promise<Authorization>;
}

// ---- src/clients/stream.d.ts ----
import type { Stream } from "../types/index.js";
import { BaseClient, type PreparedCall } from "./base.js";
/**
 * Stream: continuous per-second transfer from sender to recipient.
 *
 * One stream per deployed contract, funded up front for its whole span. There
 * is no per-second state on chain — accrual is computed from the ledger
 * timestamp whenever it is read.
 */
export declare class StreamClient extends BaseClient {
    /**
     * Creates and fully funds a stream.
     *
     * `ratePerSecond * (stop - start)` is pulled from the sender immediately, so
     * the recipient can rely on the whole span being covered. `start` may be in
     * the past, which backdates accrual.
     */
    create(args: {
        sender: string;
        recipient: string;
        token: string;
        ratePerSecond: bigint;
        start: bigint;
        stop: bigint;
        cancellable: boolean;
    }): Promise<PreparedCall<void>>;
    /**
     * Withdraws accrued funds to the recipient, returning the amount taken.
     *
     * Omit `amount` to withdraw everything currently available.
     */
    withdraw(amount?: bigint | null): Promise<PreparedCall<bigint>>;
    /**
     * Cancels the stream: settles what has accrued to the recipient and returns
     * the rest to the sender. Sender only, and only if created cancellable.
     */
    cancel(): Promise<PreparedCall<void>>;
    /**
     * Adds funds, extending `stop` by the span they buy.
     *
     * `amount` must be an exact multiple of `ratePerSecond`; a partial second
     * cannot be represented, and the contract rejects it rather than stranding
     * the remainder.
     */
    topUp(amount: bigint): Promise<PreparedCall<void>>;
    /** Extends `stop`, pulling the additional funds the longer span requires. */
    extend(newStop: bigint): Promise<PreparedCall<void>>;
    /**
     * Accrued but unwithdrawn for the recipient; refundable remainder for the
     * sender; zero for anyone else.
     */
    balanceOf(who: string): Promise<bigint>;
    /** What the contract still holds for this stream. */
    remaining(): Promise<bigint>;
    /** The full stream record. */
    get(): Promise<Stream>;
}

// ---- src/clients/vesting.d.ts ----
import type { Grant } from "../types/index.js";
import { BaseClient, type PreparedCall } from "./base.js";
/**
 * Vesting: scheduled release against a schedule, with a cliff.
 *
 * One grant per deployed contract, funded up front. Nothing vests before the
 * cliff; after it, vesting is linear until fully vested at `start + duration`.
 */
export declare class VestingClient extends BaseClient {
    /**
     * Creates and fully funds a grant.
     *
     * **`cliff` and `duration` are spans in seconds from `start`, not
     * timestamps.** `cliff === duration` is a legal all-or-nothing unlock;
     * `cliff === 0n` is linear vesting with no cliff. A cliff after the end is
     * rejected.
     */
    create(args: {
        grantor: string;
        beneficiary: string;
        token: string;
        total: bigint;
        start: bigint;
        cliff: bigint;
        duration: bigint;
        revocable: boolean;
    }): Promise<PreparedCall<void>>;
    /**
     * Transfers vested-but-unclaimed tokens to the beneficiary, returning the
     * amount claimed. Still available after revocation — a revoked grant keeps
     * its vested portion claimable.
     */
    claim(): Promise<PreparedCall<bigint>>;
    /**
     * Reclaims the unvested portion for the grantor, returning the amount
     * returned. Vesting freezes here; whatever had vested stays claimable.
     */
    revoke(): Promise<PreparedCall<bigint>>;
    /** Total vested as of `at` (a ledger timestamp), whether claimed or not. */
    vestedAmount(at: bigint): Promise<bigint>;
    /** Vested but not yet claimed, as of now. */
    claimable(): Promise<bigint>;
    /** What the contract still holds for this grant. */
    remaining(): Promise<bigint>;
    /** The full grant record. */
    get(): Promise<Grant>;
}

// ---- src/config.d.ts ----
import { Networks } from "@stellar/stellar-sdk";
/** Shared defaults for the testnet-only examples and reference app. */
export declare const TESTNET_DEFAULTS: {
    readonly rpcUrl: "https://soroban-testnet.stellar.org";
    readonly networkPassphrase: Networks.TESTNET;
    readonly nativeToken: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
};
/**
 * Validates network defaults configuration.
 *
 * Ensures rpcUrl is a valid parseable URL and networkPassphrase is a non-empty string.
 * Throws a ValidationError if any requirement is violated.
 */
export declare function validateTestnetDefaults(defaults: {
    rpcUrl: unknown;
    networkPassphrase: unknown;
    nativeToken?: unknown;
}): void;

// ---- src/errors/codes.d.ts ----
/**
 * Contract error codes, mirroring `sororail_common::errors::Error`.
 *
 * These integers are the contracts' public ABI. A released variant is never
 * renumbered and never removed, so this table can be relied on across
 * contract versions. It must stay in lockstep with
 * `contracts/common/src/errors.rs` in the `sororail-contracts` repo — the
 * ranges below are the ones reserved there.
 *
 * | Range   | Owner          |
 * |---------|----------------|
 * | 1–19    | generic        |
 * | 20–39   | `escrow`       |
 * | 40–59   | `stream`       |
 * | 60–79   | `vesting`      |
 * | 80–99   | `recurring`    |
 * | 100–119 | `batch_payout` |
 */
export declare const ErrorCode: {
    readonly AlreadyInitialized: 1;
    readonly NotInitialized: 2;
    readonly Unauthorized: 3;
    readonly InvalidAmount: 4;
    readonly InvalidTimeRange: 5;
    readonly Overflow: 6;
    readonly Underflow: 7;
    readonly DivisionByZero: 8;
    readonly InvalidBasisPoints: 9;
    readonly InvalidState: 10;
    readonly DeadlineNotReached: 11;
    readonly DeadlinePassed: 12;
    readonly InsufficientBalance: 13;
    readonly InvalidDuration: 14;
    readonly EscrowNotFundable: 20;
    readonly EscrowNotFunded: 21;
    readonly EscrowClosed: 22;
    readonly EscrowNoArbiter: 23;
    readonly EscrowNotDisputed: 24;
    readonly EscrowAlreadyDisputed: 25;
    readonly StreamNotFound: 40;
    readonly StreamCancelled: 41;
    readonly StreamNotCancellable: 42;
    readonly StreamInsufficientAccrued: 43;
    readonly StreamNotExtendable: 44;
    readonly VestingNotFound: 60;
    readonly VestingCliffNotReached: 61;
    readonly VestingNotRevocable: 62;
    readonly VestingRevoked: 63;
    readonly VestingCliffAfterEnd: 64;
    readonly VestingNothingToClaim: 65;
    readonly RecurringNotFound: 80;
    readonly RecurringCancelled: 81;
    readonly RecurringPeriodNotElapsed: 82;
    readonly RecurringExhausted: 83;
    readonly BatchEmpty: 100;
    readonly BatchTooLarge: 101;
};
export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];
/** Reverse lookup: code number to its name. */
export declare const errorCodeNames: ReadonlyMap<number, ErrorCodeName>;
/**
 * Human-readable messages.
 *
 * A user must never see a bare error code, so every variant has a sentence
 * that says what happened and, where there is one, what to do about it.
 */
export declare const errorMessages: Record<ErrorCodeName, string>;

// ---- src/errors/index.d.ts ----
import { ErrorCode, errorCodeNames, errorMessages, type ErrorCodeName } from "./codes.js";
export { ErrorCode, errorCodeNames, errorMessages };
export type { ErrorCodeName, ErrorCodeValue } from "./codes.js";
/** Which contract a decoded error came from, inferred from its code range. */
export type ContractName = "escrow" | "stream" | "vesting" | "recurring" | "batch_payout" | "common";
/** Maps a code to the contract that owns its reserved range. */
export declare function contractForCode(code: number): ContractName;
/** Base class for everything this SDK throws. */
export declare class SororailError extends Error {
    readonly name: string;
    constructor(message: string, options?: {
        cause?: unknown;
    });
    toJSON(): {
        name: string;
        message: string;
        cause: unknown;
    };
}
/**
 * A failure returned by a contract, decoded from its numeric code.
 *
 * The numeric `code` is preserved so callers can branch on it precisely,
 * `name` gives the variant, and `message` is the sentence to show a user.
 */
export declare class ContractError extends SororailError {
    readonly name: string;
    /** The ABI integer. Stable across contract versions. */
    readonly code: number;
    /** The variant name, e.g. `StreamInsufficientAccrued`. */
    readonly variant: ErrorCodeName | "Unknown";
    /** Which contract owns this code's range. */
    readonly contract: ContractName;
    constructor(code: number, variant: ErrorCodeName | "Unknown", message: string, options?: {
        cause?: unknown;
    });
    /** Whether this is the given variant. */
    is(variant: ErrorCodeName): boolean;
    toJSON(): {
        code: number;
        variant: "AlreadyInitialized" | "NotInitialized" | "Unauthorized" | "InvalidAmount" | "InvalidTimeRange" | "Overflow" | "Underflow" | "DivisionByZero" | "InvalidBasisPoints" | "InvalidState" | "DeadlineNotReached" | "DeadlinePassed" | "InsufficientBalance" | "InvalidDuration" | "EscrowNotFundable" | "EscrowNotFunded" | "EscrowClosed" | "EscrowNoArbiter" | "EscrowNotDisputed" | "EscrowAlreadyDisputed" | "StreamNotFound" | "StreamCancelled" | "StreamNotCancellable" | "StreamInsufficientAccrued" | "StreamNotExtendable" | "VestingNotFound" | "VestingCliffNotReached" | "VestingNotRevocable" | "VestingRevoked" | "VestingCliffAfterEnd" | "VestingNothingToClaim" | "RecurringNotFound" | "RecurringCancelled" | "RecurringPeriodNotElapsed" | "RecurringExhausted" | "BatchEmpty" | "BatchTooLarge" | "Unknown";
        contract: ContractName;
        name: string;
        message: string;
        cause: unknown;
    };
}
/** Thrown when a call could not be simulated or submitted at all. */
export declare class NetworkError extends SororailError {
    readonly name: string;
}
/** Thrown when arguments fail validation before anything is sent. */
export declare class ValidationError extends SororailError {
    readonly name: string;
}
/**
 * Extracts the numeric contract error code from a host error.
 *
 * The RPC surfaces contract failures as strings containing
 * `Error(Contract, #N)`. This is deliberately tolerant: the exact shape has
 * changed between protocol versions, so several spellings are matched, and
 * anything unrecognised returns `undefined` rather than a wrong code.
 */
export declare function extractErrorCode(input: unknown): number | undefined;
/**
 * Turns whatever the RPC threw into a typed error.
 *
 * A recognised contract code becomes a {@link ContractError} carrying a
 * readable message. Anything else becomes a {@link NetworkError} with the
 * original attached as `cause` — never a bare code, and never a silently
 * swallowed failure.
 */
export declare function decodeError(input: unknown): SororailError;
/** Rethrows `input` as a typed SoroRail error. Never returns. */
export declare function throwDecoded(input: unknown): never;

// ---- src/index.d.ts ----
/**
 * `@sororail/sdk` — typed TypeScript client for the SoroRail Soroban payment
 * contracts.
 *
 * Zero framework dependencies: no React, no assumptions about where it runs.
 * Signing is injected rather than performed here, so the SDK never holds a
 * secret key.
 *
 * ```ts
 * import {
 *   StreamClient,
 *   KeypairSigner,
 *   ContractError,
 *   NetworkError,
 *   SigningError,
 *   ValidationError,
 * } from "@sororail/sdk";
 * import { Networks } from "@stellar/stellar-sdk";
 *
 * const signer = new KeypairSigner(process.env.SECRET_KEY!);
 * const stream = new StreamClient({
 *   contractId: "CBEE...CGC7",
 *   rpcUrl: "https://soroban-testnet.stellar.org",
 *   networkPassphrase: Networks.TESTNET,
 *   publicKey: signer.publicKey,
 * });
 *
 * try {
 *   // Build and inspect before anyone signs.
 *   const call = await stream.withdraw();
 *   const wouldReceive = await call.simulate();
 *
 *   // Then commit.
 *   const { hash, result } = await call.signAndSend(signer);
 * } catch (error) {
 *   if (error instanceof ContractError) {
 *     // The contract refused. `message` is a sentence to show a person;
 *     // branch on the variant (or the stable numeric `code`) to recover.
 *     if (error.is("StreamInsufficientAccrued")) {
 *       // Asked for more than has accrued: withdraw less, or wait.
 *     }
 *   } else if (error instanceof ValidationError) {
 *     // Rejected before anything was sent. Fix the arguments.
 *   } else if (error instanceof SigningError) {
 *     // No wallet, locked, declined, or on the wrong network.
 *   } else if (error instanceof NetworkError) {
 *     // Could not simulate or submit. The original failure is `error.cause`.
 *   } else {
 *     throw error;
 *   }
 * }
 * ```
 *
 * Everything the SDK throws extends `SororailError`, so anything else that
 * reaches the final branch is a bug in the calling code, not a failed call.
 *
 * ## Unaudited
 *
 * The contracts this talks to have not been audited. Testnet only — do not use
 * them with real value.
 */
export { BaseClient, PreparedCall } from "./clients/base.js";
export type { ClientOptions, SentCall } from "./clients/base.js";
export { TESTNET_DEFAULTS } from "./config.js";
export { EscrowClient } from "./clients/escrow.js";
export { StreamClient } from "./clients/stream.js";
export { VestingClient } from "./clients/vesting.js";
export { RecurringClient } from "./clients/recurring.js";
export { BatchPayoutClient } from "./clients/batchPayout.js";
export { ContractError, NetworkError, SororailError, ValidationError, ErrorCode, contractForCode, decodeError, errorCodeNames, errorMessages, extractErrorCode, throwDecoded, } from "./errors/index.js";
export type { ContractName, ErrorCodeName, ErrorCodeValue } from "./errors/index.js";
export { FreighterSigner, KeypairSigner, NetworkMismatchError, SigningError, } from "./signers/index.js";
export type { FreighterApi, Signer } from "./signers/index.js";
export { EscrowState, isTerminalEscrowState, terminalEscrowStates, } from "./types/index.js";
export type { Authorization, Escrow, EscrowStateName, Grant, Payment, Receipt, Stream, } from "./types/index.js";
export { STROOPS_DECIMALS, formatAmount, fromStroops, requirePositive, toStroops, } from "./utils/amounts.js";
export { batchRead, batchReadSafe } from "./utils/batch.js";

// ---- src/signers/index.d.ts ----
import { SororailError } from "../errors/index.js";
/**
 * Signing is injected, never performed by the SDK.
 *
 * The SDK builds and submits transactions but never holds a secret key. A
 * caller supplies whatever can produce a signature — a browser wallet, an HSM,
 * a test keypair — and the SDK only ever sees signed XDR coming back.
 */
export interface Signer {
    /** The account the signature will be attributed to (`G...`). */
    readonly publicKey: string;
    /**
     * Signs a transaction envelope.
     *
     * @param xdr Base64 transaction envelope XDR.
     * @returns The signed envelope, also base64 XDR.
     */
    signTransaction(xdr: string, options: {
        networkPassphrase: string;
    }): Promise<string>;
}
/** Thrown when a wallet is missing, locked, or the user declines to sign. */
export declare class SigningError extends SororailError {
    readonly name: string;
}
/**
 * Thrown when the wallet is set to a different network than the one a
 * transaction is for. Signing there would fail or be rejected, so this says
 * which network to switch to instead.
 */
export declare class NetworkMismatchError extends SigningError {
    readonly name: string;
    /** The passphrase the wallet is currently set to. */
    readonly walletNetworkPassphrase: string;
    /** The passphrase the transaction was built for. */
    readonly expectedNetworkPassphrase: string;
    constructor(walletNetworkPassphrase: string, expectedNetworkPassphrase: string);
}
/**
 * Signs with a raw secret key held in memory.
 *
 * **For tests, scripts and server-side keys you already control.** Never ship
 * this to a browser: it means the secret is in page memory, where any script
 * on the origin can read it. Use {@link FreighterSigner} there.
 */
export declare class KeypairSigner implements Signer {
    #private;
    constructor(secretKey: string);
    /** Generates a fresh random keypair. Useful in tests. */
    static random(): KeypairSigner;
    get publicKey(): string;
    signTransaction(xdr: string, options: {
        networkPassphrase: string;
    }): Promise<string>;
}
/** The subset of the Freighter browser API this SDK uses. */
export interface FreighterApi {
    isConnected(): Promise<boolean | {
        isConnected: boolean;
    }>;
    getAddress?(): Promise<{
        address: string;
        error?: string;
    }>;
    getPublicKey?(): Promise<string>;
    /** Older versions return the network name, newer ones an object. */
    getNetwork?(): Promise<string | {
        network: string;
        networkPassphrase: string;
        error?: string;
    }>;
    getNetworkDetails?(): Promise<{
        network: string;
        networkPassphrase: string;
        error?: string;
    }>;
    signTransaction(xdr: string, options: {
        networkPassphrase?: string;
        address?: string;
    }): Promise<string | {
        signedTxXdr: string;
        error?: string;
    }>;
}
/**
 * Signs through the Freighter browser extension.
 *
 * Construct it with {@link FreighterSigner.connect}, which resolves the user's
 * address once so that `publicKey` can stay synchronous afterwards. The user
 * can still switch account or network inside the extension afterwards, so
 * {@link FreighterSigner.currentAddress} and
 * {@link FreighterSigner.networkPassphrase} read the live values, and
 * `signTransaction` refuses to sign when either no longer matches.
 *
 * The Freighter API has changed shape across versions — `getPublicKey` became
 * `getAddress`, and `signTransaction` began returning an object rather than a
 * string — so both spellings are accepted rather than pinning users to one
 * extension version.
 */
export declare class FreighterSigner implements Signer {
    #private;
    readonly publicKey: string;
    private constructor();
    /**
     * Connects to the extension and resolves the active address.
     *
     * @param api Defaults to `globalThis.freighterApi`. Pass explicitly when
     *   using the `@stellar/freighter-api` package, or a stub in tests.
     */
    static connect(api?: FreighterApi): Promise<FreighterSigner>;
    /**
     * The account currently selected in the extension. This differs from
     * `publicKey` once the user switches accounts; connect again to follow it.
     */
    currentAddress(): Promise<string>;
    /**
     * The network passphrase the extension is currently set to, or `null` when
     * this version of Freighter cannot report it.
     */
    networkPassphrase(): Promise<string | null>;
    /**
     * Throws {@link NetworkMismatchError} when the extension is on a different
     * network than `expected`. Passes when the network cannot be read.
     */
    assertNetwork(expected: string): Promise<void>;
    signTransaction(xdr: string, options: {
        networkPassphrase: string;
    }): Promise<string>;
}

// ---- src/types/index.d.ts ----
/**
 * Types mirroring the contract structs.
 *
 * Every monetary value is a `bigint` in the token's smallest unit, never a
 * `number` — `Number` loses integer precision above 2^53, which is well inside
 * the range of a real balance. Use `toStroops` / `fromStroops` at the edges.
 *
 * Timestamps are `bigint` seconds (ledger time), for the same reason: the
 * contracts use `u64`.
 */
/** Escrow lifecycle. Discriminants match the contract's ABI. */
export declare const EscrowState: {
    readonly Created: 0;
    readonly Funded: 1;
    readonly Released: 2;
    readonly Refunded: 3;
    readonly Disputed: 4;
    readonly Resolved: 5;
};
export type EscrowStateName = keyof typeof EscrowState;
/** States from which no further transition is possible. */
export declare const terminalEscrowStates: readonly EscrowStateName[];
export declare function isTerminalEscrowState(state: EscrowStateName): boolean;
/** An escrow agreement. */
export interface Escrow {
    depositor: string;
    beneficiary: string;
    /** `null` when the escrow was created without one; dispute is then unavailable. */
    arbiter: string | null;
    token: string;
    amount: bigint;
    /** Ledger timestamp after which the depositor may unilaterally refund. */
    deadline: bigint;
    state: EscrowStateName;
}
/** A payment stream. */
export interface Stream {
    sender: string;
    recipient: string;
    token: string;
    ratePerSecond: bigint;
    start: bigint;
    stop: bigint;
    cancellable: boolean;
    /** Always `ratePerSecond * (stop - start)`. */
    deposited: bigint;
    withdrawn: bigint;
    refunded: bigint;
    /** When it was cancelled, if it was. Accrual stops here. */
    cancelledAt: bigint | null;
}
/** A vesting grant. `cliff` and `duration` are spans from `start`, not timestamps. */
export interface Grant {
    grantor: string;
    beneficiary: string;
    token: string;
    total: bigint;
    start: bigint;
    /** Seconds after `start` before anything vests. */
    cliff: bigint;
    /** Seconds after `start` at which the grant is fully vested. */
    duration: bigint;
    revocable: boolean;
    claimed: bigint;
    returned: bigint;
    revokedAt: bigint | null;
}
/** A recurring pull authorization. */
export interface Authorization {
    payer: string;
    payee: string;
    token: string;
    amountPerPeriod: bigint;
    periodSeconds: bigint;
    /** `null` is open-ended. */
    maxPeriods: number | null;
    periodsCharged: number;
    nextChargeableAt: bigint;
    cancelled: boolean;
}
/** One line of a batch payout. */
export interface Payment {
    to: string;
    amount: bigint;
}
/** The outcome of a batch. */
export interface Receipt {
    count: number;
    total: bigint;
}

// ---- src/utils/amounts.d.ts ----
/**
 * Decimal places for a classic Stellar asset and for the native XLM balance.
 *
 * **The decimals trap.** This is the default, not a guarantee. A custom
 * Soroban token can declare any number of decimals, and the contracts here
 * work in the token's smallest unit without knowing or caring which. Read
 * `decimals()` off the token contract rather than assuming 7 — getting this
 * wrong scales every amount by a factor of ten.
 */
export declare const STROOPS_DECIMALS = 7;
/**
 * Converts a human-readable decimal string to the token's smallest unit.
 *
 * Takes a **string**, not a number: `0.1 + 0.2 !== 0.3` in float, and a
 * payment amount is exactly the wrong place to discover that. Truncation is
 * refused rather than performed silently — an amount with more precision than
 * the token supports is a mistake worth surfacing.
 *
 * @example toStroops("1.5") === 15000000n
 */
export declare function toStroops(amount: string, decimals?: number): bigint;
/**
 * Converts the token's smallest unit back to a decimal string.
 *
 * Returns a string rather than a number so that large balances survive the
 * trip: `Number` loses integer precision above 2^53. Keep arithmetic on
 * `bigint`-typed amount fields in `bigint`; `Number` conversion or arithmetic
 * on those fields should be flagged in review.
 *
 * @example fromStroops(15000000n) === "1.5"
 */
export declare function fromStroops(amount: bigint, decimals?: number): string;
/**
 * Formats an amount for display, keeping the token's full precision but
 * grouping the whole part so long figures stay readable in a table.
 */
export declare function formatAmount(amount: bigint, options?: {
    decimals?: number;
    locale?: string;
}): string;
/** Asserts an amount is strictly positive, as every contract requires. */
export declare function requirePositive(amount: bigint, label?: string): void;

// ---- src/utils/batch.d.ts ----
import type { BaseClient } from "../clients/base.js";
/**
 * #77 — Batch/multi-get helper for reading several positions in fewer round
 * trips. Each `read()` call is an independent Soroban simulation, so they
 * can run concurrently rather than sequentially. The SDK previously had no
 * helper for this, forcing the multi-position UI to issue one full client
 * construction + `getAccount` + simulate per position, sequentially.
 *
 * @example
 * ```ts
 * const values = await batchRead([
 *   { client: streamClient, method: "get_balance" },
 *   { client: vestingClient, method: "get_vested" },
 *   { client: escrowClient, method: "get_balance" },
 * ]);
 * // values[0] → the first successful result, in input order
 * // if any read rejects, the whole batch rejects
 * ```
 */
export declare function batchRead<T>(calls: Array<{
    client: BaseClient;
    method: string;
    args?: unknown[];
}>): Promise<T[]>;
/**
 * Returns one settled result per item in input order. Successful reads keep
 * their values, while failed reads retain their rejection reasons so callers
 * can render partial success without losing track of which item failed.
 */
export declare function batchReadSafe<T>(calls: Array<{
    client: BaseClient;
    method: string;
    args?: unknown[];
}>): Promise<PromiseSettledResult<T>[]>;

// ---- src/utils/scval.d.ts ----
import { xdr } from "@stellar/stellar-sdk";
/** Builders for contract arguments, so call sites stay readable. */
export declare function addr(value: string): xdr.ScVal;
export declare function i128(value: bigint): xdr.ScVal;
export declare function u64(value: bigint | number): xdr.ScVal;
export declare function u32(value: number): xdr.ScVal;
export declare function bool(value: boolean): xdr.ScVal;
/** `Option<T>`: `null`/`undefined` becomes void, anything else the value. */
export declare function some(value: xdr.ScVal | null | undefined): xdr.ScVal;
export declare function optionAddress(value: string | null | undefined): xdr.ScVal;
export declare function optionI128(value: bigint | null | undefined): xdr.ScVal;
export declare function optionU32(value: number | null | undefined): xdr.ScVal;
export declare function vec(values: xdr.ScVal[]): xdr.ScVal;
/** Parsers for what `scValToNative` hands back. */
export declare function asBigInt(value: unknown, field: string): bigint;
export declare function asNumber(value: unknown, field: string): number;
export declare function asString(value: unknown, field: string): string;
export declare function asBoolean(value: unknown, field: string): boolean;
/** `Option<T>` comes back as `undefined` or `null` when empty. */
export declare function asOptional<T>(value: unknown, parse: (value: unknown) => T): T | null;
export declare function asRecord(value: unknown, what: string): Record<string, unknown>;
/**
 * Checks the return value of an entry point that returns `()`. A void result
 * comes back as `undefined` (no return value) or `null` (`scvVoid`); anything
 * else means the deployed contract does not match this SDK version.
 */
export declare function asVoid(value?: unknown): void;
