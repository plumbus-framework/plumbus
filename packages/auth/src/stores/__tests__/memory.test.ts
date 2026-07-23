import { createMemoryLoginTransactionStore, createMemorySessionStore } from '../memory.js';
import { describeLoginTransactionStoreContract, describeSessionStoreContract } from './contract.js';

describeSessionStoreContract('memory', createMemorySessionStore);
describeLoginTransactionStoreContract('memory', createMemoryLoginTransactionStore);
