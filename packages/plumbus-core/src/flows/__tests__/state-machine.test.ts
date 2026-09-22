import { describe, expect, it } from 'vitest';
import { assertTransition, FlowStatus, isTerminal, isValidTransition } from '../state-machine.js';

describe('FlowStateMachine', () => {
  describe('isValidTransition', () => {
    it('allows created → running', () => {
      expect(isValidTransition(FlowStatus.Created, FlowStatus.Running)).toBe(true);
    });

    it('allows created → cancelled', () => {
      expect(isValidTransition(FlowStatus.Created, FlowStatus.Cancelled)).toBe(true);
    });

    it('allows running → waiting', () => {
      expect(isValidTransition(FlowStatus.Running, FlowStatus.Waiting)).toBe(true);
    });

    it('allows running → completed', () => {
      expect(isValidTransition(FlowStatus.Running, FlowStatus.Completed)).toBe(true);
    });

    it('allows running → failed', () => {
      expect(isValidTransition(FlowStatus.Running, FlowStatus.Failed)).toBe(true);
    });

    it('allows waiting → running (resume)', () => {
      expect(isValidTransition(FlowStatus.Waiting, FlowStatus.Running)).toBe(true);
    });

    it('rejects completed → running', () => {
      expect(isValidTransition(FlowStatus.Completed, FlowStatus.Running)).toBe(false);
    });

    it('rejects failed → running', () => {
      expect(isValidTransition(FlowStatus.Failed, FlowStatus.Running)).toBe(false);
    });

    it('rejects created → completed (skip running)', () => {
      expect(isValidTransition(FlowStatus.Created, FlowStatus.Completed)).toBe(false);
    });
  });

  describe('assertTransition', () => {
    it('does not throw for valid transitions', () => {
      expect(() => assertTransition(FlowStatus.Created, FlowStatus.Running)).not.toThrow();
    });

    it('throws for invalid transitions', () => {
      expect(() => assertTransition(FlowStatus.Completed, FlowStatus.Running)).toThrow(
        'Invalid flow status transition',
      );
    });
  });

  describe('isTerminal', () => {
    it('completed is terminal', () => {
      expect(isTerminal(FlowStatus.Completed)).toBe(true);
    });

    it('failed is terminal', () => {
      expect(isTerminal(FlowStatus.Failed)).toBe(true);
    });

    it('cancelled is terminal', () => {
      expect(isTerminal(FlowStatus.Cancelled)).toBe(true);
    });

    it('running is not terminal', () => {
      expect(isTerminal(FlowStatus.Running)).toBe(false);
    });

    it('waiting is not terminal', () => {
      expect(isTerminal(FlowStatus.Waiting)).toBe(false);
    });

    it('created is not terminal', () => {
      expect(isTerminal(FlowStatus.Created)).toBe(false);
    });
  });
});
