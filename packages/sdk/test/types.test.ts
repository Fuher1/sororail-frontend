import { describe, expect, it } from "vitest";

import {
  EscrowState,
  isTerminalEscrowState,
  terminalEscrowStates,
  type EscrowStateName,
} from "../src/types/index.js";

describe("isTerminalEscrowState (#242)", () => {
  it("returns true for all terminal states", () => {
    // Explicitly check each defined terminal state: Released, Refunded, Resolved
    expect(isTerminalEscrowState("Released")).toBe(true);
    expect(isTerminalEscrowState("Refunded")).toBe(true);
    expect(isTerminalEscrowState("Resolved")).toBe(true);

    for (const state of terminalEscrowStates) {
      expect(isTerminalEscrowState(state)).toBe(true);
    }
  });

  it("returns false for non-terminal states", () => {
    // Check known non-terminal escrow lifecycle states: Created, Funded, Disputed
    expect(isTerminalEscrowState("Created")).toBe(false);
    expect(isTerminalEscrowState("Funded")).toBe(false);
    expect(isTerminalEscrowState("Disputed")).toBe(false);
  });

  it("correctly partitions every state in EscrowState", () => {
    const allStates = Object.keys(EscrowState) as EscrowStateName[];
    for (const state of allStates) {
      if (terminalEscrowStates.includes(state)) {
        expect(isTerminalEscrowState(state)).toBe(true);
      } else {
        expect(isTerminalEscrowState(state)).toBe(false);
      }
    }
  });

  it("returns false for unknown or invalid states", () => {
    expect(isTerminalEscrowState("Pending" as EscrowStateName)).toBe(false);
    expect(isTerminalEscrowState("Cancelled" as EscrowStateName)).toBe(false);
    expect(isTerminalEscrowState("" as EscrowStateName)).toBe(false);
    expect(isTerminalEscrowState("unknown" as EscrowStateName)).toBe(false);
  });
});
