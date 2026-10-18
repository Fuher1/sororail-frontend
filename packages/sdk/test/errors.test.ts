import { describe, expect, it } from "vitest";

import {
  ContractError,
  ErrorCode,
  NetworkError,
  SororailError,
  ValidationError,
  contractForCode,
  decodeError,
  errorCodeNames,
  errorMessages,
  extractErrorCode,
} from "../src/errors/index.js";

describe("the code table", () => {
  it("matches the ranges reserved in sororail_common::errors", () => {
    // Spot-check a boundary from each contract's range. If these drift, a
    // client will decode a failure as the wrong thing.
    expect(ErrorCode.AlreadyInitialized).toBe(1);
    expect(ErrorCode.InvalidDuration).toBe(14);
    expect(ErrorCode.EscrowNotFundable).toBe(20);
    expect(ErrorCode.StreamNotFound).toBe(40);
    expect(ErrorCode.VestingNotFound).toBe(60);
    expect(ErrorCode.RecurringNotFound).toBe(80);
    expect(ErrorCode.BatchEmpty).toBe(100);
  });

  it("assigns no code twice", () => {
    const codes = Object.values(ErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("leaves 102 burned", () => {
    // BatchDuplicateRecipient was removed before release; the number is not
    // reused, so a stale client decoding 102 gets "unknown" rather than a
    // confidently wrong answer.
    expect(errorCodeNames.has(102)).toBe(false);
  });

  it("gives every variant a readable message", () => {
    for (const name of Object.keys(ErrorCode) as (keyof typeof ErrorCode)[]) {
      const message = errorMessages[name];
      expect(message, name).toBeTruthy();
      // A user must never see a bare code, so no message may be just the name.
      expect(message, name).not.toBe(name);
      expect(message.length, name).toBeGreaterThan(15);
    }
  });

  it("maps every ErrorCode to an entry in errorCodeNames (#240)", () => {
    for (const [name, code] of Object.entries(ErrorCode)) {
      expect(
        errorCodeNames.has(code),
        `errorCodeNames must contain an entry for ${name} (code ${code})`,
      ).toBe(true);
      expect(
        errorCodeNames.get(code),
        `errorCodeNames.get(${code}) must match ${name}`,
      ).toBe(name);
    }
  });

  it("provides a user-facing message in errorMessages for every ErrorCode (#241)", () => {
    for (const [name, code] of Object.entries(ErrorCode)) {
      const message = errorMessages[name as keyof typeof ErrorCode];
      expect(
        typeof message,
        `errorMessages must have a message for ${name} (code ${code})`,
      ).toBe("string");
      expect(
        message.trim().length,
        `errorMessages[${name}] must not be empty`,
      ).toBeGreaterThan(0);
      expect(
        message,
        `errorMessages[${name}] must not be just the variant name`,
      ).not.toBe(name);
    }
  });
});

describe("contractForCode", () => {
  it("routes each range to its owner", () => {
    expect(contractForCode(1)).toBe("common");
    expect(contractForCode(22)).toBe("escrow");
    expect(contractForCode(43)).toBe("stream");
    expect(contractForCode(61)).toBe("vesting");
    expect(contractForCode(82)).toBe("recurring");
    expect(contractForCode(101)).toBe("batch_payout");
  });

  it("accurately categorises exact boundary values for every reserved range", () => {
    // Range: common (<20, >=120)
    expect(contractForCode(-1)).toBe("common");
    expect(contractForCode(0)).toBe("common");
    expect(contractForCode(19)).toBe("common");

    // Range: escrow [20, 39]
    expect(contractForCode(20)).toBe("escrow");
    expect(contractForCode(39)).toBe("escrow");

    // Range: stream [40, 59]
    expect(contractForCode(40)).toBe("stream");
    expect(contractForCode(59)).toBe("stream");

    // Range: vesting [60, 79]
    expect(contractForCode(60)).toBe("vesting");
    expect(contractForCode(79)).toBe("vesting");

    // Range: recurring [80, 99]
    expect(contractForCode(80)).toBe("recurring");
    expect(contractForCode(99)).toBe("recurring");

    // Range: batch_payout [100, 119]
    expect(contractForCode(100)).toBe("batch_payout");
    expect(contractForCode(119)).toBe("batch_payout");

    // Upper boundary fallback to common (>=120)
    expect(contractForCode(120)).toBe("common");
    expect(contractForCode(121)).toBe("common");
    expect(contractForCode(500)).toBe("common");
  });
});

describe("extractErrorCode", () => {
  it("reads the host's Error(Contract, #N) form", () => {
    expect(
      extractErrorCode("HostError: Error(Contract, #43)"),
    ).toBe(43);
  });

  it("tolerates the other shapes the RPC has used", () => {
    expect(extractErrorCode("ContractError(21)")).toBe(21);
    expect(extractErrorCode('{"contract_error": 61}')).toBe(61);
  });

  it("reads through an Error object", () => {
    expect(extractErrorCode(new Error("failed: Error(Contract, #2)"))).toBe(2);
  });

  it("returns undefined rather than guessing", () => {
    expect(extractErrorCode("connection reset")).toBeUndefined();
    expect(extractErrorCode(null)).toBeUndefined();
    expect(extractErrorCode({ nothing: true })).toBeUndefined();
  });

  it("falls back gracefully on a circular object without throwing an error", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(extractErrorCode(circular)).toBeUndefined();

    const circularWithCode: Record<string, unknown> = {};
    circularWithCode.self = circularWithCode;
    circularWithCode.toString = () => "HostError: Error(Contract, #42)";
    expect(extractErrorCode(circularWithCode)).toBe(42);
  });

  describe("matches all four documented regex patterns independently", () => {
    it("matches Error(Contract, #N) with varying whitespace", () => {
      expect(extractErrorCode("Error(Contract, #42)")).toBe(42);
      expect(extractErrorCode("Error(Contract,#42)")).toBe(42);
      expect(extractErrorCode("HostError: Error(Contract,   #99) in call")).toBe(99);
    });

    it("matches ContractError(N) pattern", () => {
      expect(extractErrorCode("ContractError(42)")).toBe(42);
      expect(extractErrorCode("Transaction error: ContractError(15)")).toBe(15);
    });

    it('matches JSON-ish "contract_error": N pattern with varying whitespace', () => {
      expect(extractErrorCode('{"contract_error": 61}')).toBe(61);
      expect(extractErrorCode('{"contract_error" : 88}')).toBe(88);
      expect(extractErrorCode('wrapped {"contract_error":105} response')).toBe(105);
    });

    it("matches trailing #N pattern", () => {
      expect(extractErrorCode("host call failed with #42")).toBe(42);
      expect(extractErrorCode("invocation failed #77)")).toBe(77);
      expect(extractErrorCode("failed #100 ) ")).toBe(100);
    });

    it("returns undefined for non-numeric or non-matching tokens", () => {
      expect(extractErrorCode("Error(Contract, #abc)")).toBeUndefined();
      expect(extractErrorCode("ContractError()")).toBeUndefined();
      expect(extractErrorCode('{"contract_error": "none"}')).toBeUndefined();
      expect(extractErrorCode("#notanumber")).toBeUndefined();
    });
  });
});

describe("decodeError", () => {
  it("turns a known code into a typed, readable error", () => {
    const error = decodeError("HostError: Error(Contract, #43)");
    expect(error).toBeInstanceOf(ContractError);
    const contractError = error as ContractError;
    expect(contractError.code).toBe(43);
    expect(contractError.variant).toBe("StreamInsufficientAccrued");
    expect(contractError.contract).toBe("stream");
    expect(contractError.is("StreamInsufficientAccrued")).toBe(true);
    expect(contractError.message).toMatch(/more than has accrued/i);
  });

  it("keeps an unknown code rather than pretending", () => {
    const error = decodeError("Error(Contract, #999)") as ContractError;
    expect(error).toBeInstanceOf(ContractError);
    expect(error.code).toBe(999);
    expect(error.variant).toBe("Unknown");
    expect(error.message).toMatch(/does not recognise/i);
  });

  it("produces an 'Unknown' ContractError for an unrecognised code with forward compatibility", () => {
    const error = decodeError("Error(Contract, #999)");
    expect(error).toBeInstanceOf(ContractError);
    const contractError = error as ContractError;
    expect(contractError.name).toBe("ContractError");
    expect(contractError.code).toBe(999);
    expect(contractError.variant).toBe("Unknown");
    expect(contractError.contract).toBe("common");
    expect(contractError.is("Unknown" as any)).toBe(true);
    expect(contractError.message).toBe(
      "The contract failed with code 999, which this version of the SDK does not recognise. It may be newer than the SDK.",
    );
    expect(contractError.cause).toBe("Error(Contract, #999)");
    expect(contractError.toJSON()).toEqual({
      name: "ContractError",
      message:
        "The contract failed with code 999, which this version of the SDK does not recognise. It may be newer than the SDK.",
      code: 999,
      variant: "Unknown",
      contract: "common",
      cause: "Error(Contract, #999)",
    });

    const burnedError = decodeError("Error(Contract, #102)") as ContractError;
    expect(burnedError.code).toBe(102);
    expect(burnedError.variant).toBe("Unknown");
    expect(burnedError.contract).toBe("batch_payout");
  });

  it("falls back to NetworkError with the cause attached", () => {
    const cause = new Error("socket hang up");
    const error = decodeError(cause);
    expect(error).toBeInstanceOf(NetworkError);
    expect(error.message).toBe("socket hang up");
    expect(error.cause).toBe(cause);
  });

  it("passes our own errors through untouched", () => {
    const original = new ValidationError("bad input");
    expect(decodeError(original)).toBe(original);
  });

  it("explains the consumer-protection rule on recurring", () => {
    const error = decodeError("Error(Contract, #82)") as ContractError;
    expect(error.variant).toBe("RecurringPeriodNotElapsed");
    expect(error.message).toMatch(/not billable later/i);
  });

  it("tells a caller how to recover from an oversized batch", () => {
    const error = decodeError("Error(Contract, #101)") as ContractError;
    expect(error.variant).toBe("BatchTooLarge");
    expect(error.message).toMatch(/maxRecipients/);
  });

  it("produces a SororailError (not a raw TypeError) for truly unknown inputs", () => {
    expect(decodeError(null)).toBeInstanceOf(SororailError);
    expect(decodeError(undefined)).toBeInstanceOf(SororailError);
    expect(decodeError(42)).toBeInstanceOf(SororailError);
    expect(decodeError({ someField: true })).toBeInstanceOf(SororailError);
    expect(() => decodeError(Symbol("x"))).not.toThrow(TypeError);
  });
});

describe("ValidationError (#239)", () => {
  it("preserves the message passed to the constructor", () => {
    const err = new ValidationError("amount must be positive");
    expect(err.message).toBe("amount must be positive");
  });

  it("is an instance of SororailError", () => {
    expect(new ValidationError("x")).toBeInstanceOf(SororailError);
  });

  it("carries the correct name after transpilation", () => {
    expect(new ValidationError("x").name).toBe("ValidationError");
  });

  it("exposes cause when provided", () => {
    const cause = new RangeError("out of range");
    const err = new ValidationError("bad value", { cause });
    expect(err.cause).toBe(cause);
  });
});
