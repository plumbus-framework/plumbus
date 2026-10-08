// Every payments capability, exported as one collection: discovery registers
// each one (including the system-only webhook capabilities the worker needs).
import { payments } from '../payments/index.js';

export const paymentCapabilities = payments.capabilities;
