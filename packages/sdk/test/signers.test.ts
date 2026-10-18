import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FreighterSigner,
  KeypairSigner,
  NetworkMismatchError,
  SigningError,
  type FreighterApi,
} from "../src/signers/index.js";
import { SororailError, ValidationError } from "../src/errors/index.js";

const ALICE = "GC4RWN3HH5H5GMD3NT4MOIYC3H3Q3NUF4BFWATGDI7NKRVLRURKHSIMC";
const BOB = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";

/** An unsigned one-operation transaction envelope for `source`. */
function buildUnsignedXdr(source: string): string {
  return new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: ALICE, asset: Asset.native(), amount: "1" }))
    .setTimeout(0)
    .build()
    .toXDR();
}

/** A stub extension whose selected account and network can be changed. */
function stubFreighter(options: { network?: string } = {}) {
  const state = { address: ALICE, network: options.network };
  const signTransaction = vi.fn(async (xdr: string) => ({ signedTxXdr: `signed:${xdr}` }));
  const api: FreighterApi = {
    isConnected: async () => true,
    getAddress: async () => ({ address: state.address }),
    signTransaction,
    ...(state.network !== undefined
      ? {
          getNetworkDetails: async () => ({
            network: "",
            networkPassphrase: state.network ?? "",
          }),
        }
      : {}),
  };
  return { api, state, signTransaction };
}

describe("FreighterSigner account switching", () => {
  it("reads the live account, not the one it connected with", async () => {
    const { api, state } = stubFreighter();
    const signer = await FreighterSigner.connect(api);

    state.address = BOB;

    expect(signer.publicKey).toBe(ALICE);
    await expect(signer.currentAddress()).resolves.toBe(BOB);
  });

  it("refuses to sign once the extension has switched accounts", async () => {
    const { api, state, signTransaction } = stubFreighter();
    const signer = await FreighterSigner.connect(api);

    state.address = BOB;

    const attempt = signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET });
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow(/active account changed.*Reconnect/);
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("signs as the connected account while it is still selected", async () => {
    const { api, signTransaction } = stubFreighter({ network: Networks.TESTNET });
    const signer = await FreighterSigner.connect(api);

    await expect(
      signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET }),
    ).resolves.toBe("signed:AAAA");
    expect(signTransaction).toHaveBeenCalledWith("AAAA", {
      networkPassphrase: Networks.TESTNET,
      address: ALICE,
    });
  });
});

describe("FreighterSigner network checks", () => {
  it("refuses to sign on a different network, saying which one to switch to", async () => {
    const { api, signTransaction } = stubFreighter({ network: Networks.PUBLIC });
    const signer = await FreighterSigner.connect(api);

    const attempt = signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET });
    await expect(attempt).rejects.toBeInstanceOf(NetworkMismatchError);
    await expect(attempt).rejects.toThrow(
      "Freighter is set to Mainnet, but Testnet is needed here. Switch Freighter to Testnet and try again.",
    );
    expect(signTransaction).not.toHaveBeenCalled();
  });

  it("is a SigningError carrying both passphrases", async () => {
    const { api } = stubFreighter({ network: Networks.PUBLIC });
    const signer = await FreighterSigner.connect(api);

    const error = await signer.assertNetwork(Networks.TESTNET).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SigningError);
    expect(error).toMatchObject({
      name: "NetworkMismatchError",
      walletNetworkPassphrase: Networks.PUBLIC,
      expectedNetworkPassphrase: Networks.TESTNET,
    });
  });

  it("reads the network from each Freighter API shape", async () => {
    const base: FreighterApi = {
      isConnected: async () => true,
      getAddress: async () => ({ address: ALICE }),
      signTransaction: async (xdr) => xdr,
    };

    const legacy = await FreighterSigner.connect({ ...base, getNetwork: async () => "PUBLIC" });
    await expect(legacy.networkPassphrase()).resolves.toBe(Networks.PUBLIC);

    const current = await FreighterSigner.connect({
      ...base,
      getNetwork: async () => ({ network: "TESTNET", networkPassphrase: Networks.TESTNET }),
    });
    await expect(current.networkPassphrase()).resolves.toBe(Networks.TESTNET);

    const unreported = await FreighterSigner.connect(base);
    await expect(unreported.networkPassphrase()).resolves.toBeNull();
    // A network that cannot be read is not treated as a mismatch.
    await expect(unreported.assertNetwork(Networks.TESTNET)).resolves.toBeUndefined();
  });
});

describe("FreighterSigner.connect address resolution", () => {
  const base = {
    isConnected: async () => true,
    signTransaction: async (xdr: string) => xdr,
  };

  it("reads the address from the current getAddress() API shape", async () => {
    const api: FreighterApi = {
      ...base,
      getAddress: async () => ({ address: ALICE }),
    };

    const signer = await FreighterSigner.connect(api);
    expect(signer.publicKey).toBe(ALICE);
  });

  it("falls back to the legacy getPublicKey() API shape", async () => {
    const api: FreighterApi = {
      ...base,
      getPublicKey: async () => ALICE,
    };

    const signer = await FreighterSigner.connect(api);
    expect(signer.publicKey).toBe(ALICE);
  });

  it("throws when getAddress() reports an error", async () => {
    const api: FreighterApi = {
      ...base,
      getAddress: async () => ({ address: "", error: "User declined access" }),
    };

    const attempt = FreighterSigner.connect(api);
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow("User declined access");
  });

  it("throws when Freighter reports no address at all", async () => {
    const api: FreighterApi = {
      ...base,
      getAddress: async () => ({ address: "" }),
    };

    const attempt = FreighterSigner.connect(api);
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow(/did not return an address/);
  });
});

describe("FreighterSigner.signTransaction result shapes", () => {
  function connectedSigner(signTransaction: FreighterApi["signTransaction"]) {
    return FreighterSigner.connect({
      isConnected: async () => true,
      getAddress: async () => ({ address: ALICE }),
      signTransaction,
    });
  }

  it("accepts a bare signed-XDR string", async () => {
    const signer = await connectedSigner(async (xdr) => `signed:${xdr}`);

    await expect(
      signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET }),
    ).resolves.toBe("signed:AAAA");
  });

  it("accepts an {signedTxXdr} object", async () => {
    const signer = await connectedSigner(async (xdr) => ({ signedTxXdr: `signed:${xdr}` }));

    await expect(
      signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET }),
    ).resolves.toBe("signed:AAAA");
  });

  it("throws when the result object carries an error", async () => {
    const signer = await connectedSigner(async () => ({
      signedTxXdr: "",
      error: "User declined access",
    }));

    const attempt = signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET });
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow("User declined access");
  });

  it("wraps a thrown/declined signature in a SigningError", async () => {
    const cause = new Error("User rejected the request");
    const signer = await connectedSigner(async () => {
      throw cause;
    });

    const attempt = signer.signTransaction("AAAA", { networkPassphrase: Networks.TESTNET });
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow(/did not sign the transaction/);
    await expect(attempt).rejects.toMatchObject({ cause });
  });
});

describe("KeypairSigner constructor", () => {
  it("accepts a valid Stellar secret key and derives the matching public key", () => {
    const keypair = Keypair.random();
    const signer = new KeypairSigner(keypair.secret());

    expect(signer.publicKey).toBe(keypair.publicKey());
  });

  it("rejects an invalid secret key with a ValidationError rather than a raw exception", () => {
    expect(() => new KeypairSigner("not-a-valid-secret")).toThrow(ValidationError);
    expect(() => new KeypairSigner("not-a-valid-secret")).toThrow(
      "That is not a valid Stellar secret key. It should begin with S and be 56 characters.",
    );
  });

  it("preserves the underlying stellar-sdk cause on the ValidationError", () => {
    let capturedError: unknown;
    try {
      new KeypairSigner("invalid-secret");
    } catch (err) {
      capturedError = err;
    }

    expect(capturedError).toBeInstanceOf(ValidationError);
    expect(capturedError).toBeInstanceOf(SororailError);
    expect((capturedError as ValidationError).name).toBe("ValidationError");
    expect((capturedError as ValidationError).message).toBe(
      "That is not a valid Stellar secret key. It should begin with S and be 56 characters.",
    );
    expect((capturedError as ValidationError).cause).toBeDefined();
    expect((capturedError as ValidationError).cause).toBeInstanceOf(Error);
  });

  it.each([
    ["empty string", ""],
    ["arbitrary non-base32 text", "super-secret-key-that-is-not-stellar"],
    ["a public key instead of a secret key", ALICE],
    ["secret with invalid prefix", "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI"],
    ["too short (55 chars)", "S" + "A".repeat(54)],
    ["too long (57 chars)", "S" + "A".repeat(56)],
    ["invalid characters", "S" + "0".repeat(55)],
    ["invalid checksum", "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("rejects %s with documented ValidationError", (_label, invalidSecret) => {
    expect(() => new KeypairSigner(invalidSecret)).toThrow(ValidationError);
    expect(() => new KeypairSigner(invalidSecret)).toThrow(
      "That is not a valid Stellar secret key. It should begin with S and be 56 characters.",
    );
  });
});

describe("KeypairSigner.random", () => {
  it("produces a signer with a valid G... public key", () => {
    const signer = KeypairSigner.random();

    expect(signer.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(StrKey.isValidEd25519PublicKey(signer.publicKey)).toBe(true);
  });

  it("generates a different account each time", () => {
    expect(KeypairSigner.random().publicKey).not.toBe(KeypairSigner.random().publicKey);
  });

  it("can sign a transaction as its own account", async () => {
    const signer = KeypairSigner.random();
    const xdr = buildUnsignedXdr(signer.publicKey);

    const signed = await signer.signTransaction(xdr, { networkPassphrase: Networks.TESTNET });

    const tx = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    expect(tx.signatures).toHaveLength(1);
  });
});

describe("KeypairSigner.signTransaction", () => {
  it("round-trips the envelope, adding one signature that verifies", async () => {
    const keypair = Keypair.random();
    const signer = new KeypairSigner(keypair.secret());
    const xdr = buildUnsignedXdr(keypair.publicKey());
    const before = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
    expect(before.signatures).toHaveLength(0);

    const signed = await signer.signTransaction(xdr, { networkPassphrase: Networks.TESTNET });

    expect(signed).not.toBe(xdr);
    const after = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    // Content is unchanged; only the signature was added.
    expect(Buffer.from(after.hash()).equals(Buffer.from(before.hash()))).toBe(true);
    expect(after.signatures).toHaveLength(1);
    expect(keypair.verify(after.hash(), after.signatures[0]!.signature)).toBe(true);
  });

  it("signs against the given network passphrase", async () => {
    const keypair = Keypair.random();
    const signer = new KeypairSigner(keypair.secret());
    const xdr = buildUnsignedXdr(keypair.publicKey());

    const signed = await signer.signTransaction(xdr, { networkPassphrase: Networks.PUBLIC });

    const asPublic = TransactionBuilder.fromXDR(signed, Networks.PUBLIC);
    const asTestnet = TransactionBuilder.fromXDR(signed, Networks.TESTNET);
    const signature = asPublic.signatures[0]!.signature;
    expect(keypair.verify(asPublic.hash(), signature)).toBe(true);
    // The signature is bound to the passphrase it was made for.
    expect(keypair.verify(asTestnet.hash(), signature)).toBe(false);
  });

  it("rejects malformed XDR", async () => {
    const signer = KeypairSigner.random();

    await expect(
      signer.signTransaction("not-xdr", { networkPassphrase: Networks.TESTNET }),
    ).rejects.toThrow();
  });
});

describe("FreighterSigner.connect availability", () => {
  afterEach(() => {
    delete (globalThis as { freighterApi?: FreighterApi }).freighterApi;
  });

  it("throws SigningError when no extension is present", async () => {
    delete (globalThis as { freighterApi?: FreighterApi }).freighterApi;

    const attempt = FreighterSigner.connect();
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow(/Freighter was not found/);
  });

  it("uses globalThis.freighterApi when no api is passed", async () => {
    (globalThis as { freighterApi?: FreighterApi }).freighterApi = stubFreighter().api;

    const signer = await FreighterSigner.connect();
    expect(signer.publicKey).toBe(ALICE);
  });

  it.each([
    ["a boolean false", async () => false],
    ["an { isConnected: false } object", async () => ({ isConnected: false })],
  ])("throws SigningError when isConnected() returns %s", async (_label, isConnected) => {
    const getAddress = vi.fn(async () => ({ address: ALICE }));
    const api: FreighterApi = { isConnected, getAddress, signTransaction: async (x) => x };

    const attempt = FreighterSigner.connect(api);
    await expect(attempt).rejects.toBeInstanceOf(SigningError);
    await expect(attempt).rejects.toThrow(/installed but not connected/);
    expect(getAddress).not.toHaveBeenCalled();
  });

  it("accepts an { isConnected: true } object", async () => {
    const api: FreighterApi = {
      isConnected: async () => ({ isConnected: true }),
      getAddress: async () => ({ address: ALICE }),
      signTransaction: async (x) => x,
    };

    await expect(FreighterSigner.connect(api)).resolves.toMatchObject({ publicKey: ALICE });
  });
});

// Issue #248: inheritance and fields of the error classes themselves, not
// just that other code happens to throw them.
describe("SigningError / NetworkMismatchError", () => {
  it("SigningError is a SororailError carrying its message", () => {
    const error = new SigningError("wallet locked");
    expect(error).toBeInstanceOf(SororailError);
    expect(error.name).toBe("SigningError");
    expect(error.message).toBe("wallet locked");
  });

  it("NetworkMismatchError is a SigningError carrying both passphrases", () => {
    const error = new NetworkMismatchError(Networks.TESTNET, Networks.PUBLIC);
    expect(error).toBeInstanceOf(SigningError);
    expect(error).toBeInstanceOf(SororailError);
    expect(error.walletNetworkPassphrase).toBe(Networks.TESTNET);
    expect(error.expectedNetworkPassphrase).toBe(Networks.PUBLIC);
  });
});
