import type { AICostRecord, ExecutionContext } from '@plumbus/core';
import type { AICostContextLike } from '../types/cost.js';
import type { VoiceProviderCredentials } from '../types/provider.js';

/** Server-only file processing. Applications persist every attempt before invoking it. */
export interface FileTranscriptionConfig {
  model: string;
  /** Explicit deployment region; the provider validates supported values. */
  region: string;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxTokens?: number;
  maxPages?: number;
  pageSize?: number;
  timeoutMs?: number;
  languageHints?: string[];
}
export interface FileTranscriptionOperationOptions {
  signal?: AbortSignal;
  /** Required before upload/submission. Admission and durable reservation are app-owned. */
  estimatedCostUsd?: number;
}
export type FileTranscriptionContext = Pick<ExecutionContext, 'ai' | 'signal'>;
export interface FileTranscriptionUploadInput {
  bytes: Uint8Array | AsyncIterable<Uint8Array>;
  byteLength: number;
  contentType: string;
  /** Opaque, random per-attempt reference. Never an original filename or user identity. */
  uploadReference: string;
}
export type FileTranscriptionUnknownReason =
  | 'outcome_unknown'
  | 'not_found'
  | 'ambiguous'
  | 'page_limit';
export type FileTranscriptionUploadResult =
  | { state: 'uploaded'; fileId: string; uploadReference: string }
  | { state: 'unknown'; uploadReference: string; reason: FileTranscriptionUnknownReason };
export interface FileTranscriptionSubmitInput {
  fileId: string;
  clientReference: string;
}
export interface FileTranscriptionReconcileInput extends FileTranscriptionSubmitInput {
  createdAfter: string;
  createdBefore: string;
}
export interface FileTranscriptionReconcileUploadInput {
  uploadReference: string;
  byteLength: number;
  createdAfter: string;
  createdBefore: string;
}
export interface FileTranscriptionJob {
  jobId: string;
  fileId: string;
  model: string;
  clientReference?: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  audioSeconds?: number;
  /** Stable category only; never raw provider text. */
  errorCode?: string;
}
export type FileTranscriptionSubmissionResult =
  | { state: 'submitted'; job: FileTranscriptionJob }
  | { state: 'unknown'; reason: FileTranscriptionUnknownReason };
export interface FileTranscriptionTimedToken {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number;
  language?: string;
  speaker?: string;
}
export interface FileTranscriptionTranscript {
  text: string;
  tokens: FileTranscriptionTimedToken[];
}
export interface FileTranscriptionKnownUsage {
  state: 'known';
  /** Actual billing-row identity when supplied; may differ from the transcription job ID. */
  providerUsageId?: string;
  audioSeconds: number;
  inputAudioTokens: number;
  inputTextTokens: number;
  outputTextTokens: number;
  /** Provider-reported cost, null when unavailable. Never infer free usage. */
  costUsd: number | null;
}
export type FileTranscriptionUsage =
  | FileTranscriptionKnownUsage
  | { state: 'unknown'; reason: FileTranscriptionUnknownReason };
export interface FileTranscriptionUsageInput {
  /** Trusted server-persisted getJob receipt, allowing measured billing after privacy deletion. */
  verifiedJob?: FileTranscriptionJob;
  /** Original persisted uploaded-file ID; required with verifiedJob, never browser-supplied. */
  fileId?: string;
  jobId: string;
  clientReference: string;
  /** Bounded UTC window containing the provider request's completion time. */
  startedAfter: string;
  endedBefore: string;
}
export type FileTranscriptionDeleteResult = { state: 'deleted' | 'pending' };
export interface FileTranscriptionProvider {
  upload(
    input: FileTranscriptionUploadInput,
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionUploadResult>;
  reconcileUpload(
    input: FileTranscriptionReconcileUploadInput,
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionUploadResult>;
  submit(
    input: FileTranscriptionSubmitInput,
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionSubmissionResult>;
  reconcileSubmission(
    input: FileTranscriptionReconcileInput,
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionSubmissionResult>;
  getJob(
    input: { jobId: string },
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionJob | null>;
  getTranscript(
    input: { jobId: string },
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionTranscript | null>;
  getUsage(
    input: FileTranscriptionUsageInput,
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionUsage>;
  deleteJob(
    input: { jobId: string },
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionDeleteResult>;
  deleteFile(
    input: { fileId: string },
    options?: FileTranscriptionOperationOptions,
  ): Promise<FileTranscriptionDeleteResult>;
}
export interface FileTranscriptionProviderRegistration {
  id: string;
  create(
    credentials: VoiceProviderCredentials,
    config: FileTranscriptionConfig,
  ): FileTranscriptionProvider;
}
export interface FileTranscriptionPricing {
  inputAudioUsdPerMillion: number;
  inputTextUsdPerMillion: number;
  outputTextUsdPerMillion: number;
}
export interface RecordFileTranscriptionCostInput {
  provider: string;
  model: string;
  usage: FileTranscriptionUsage;
  pricing?: FileTranscriptionPricing;
  latencyMs: number;
  costContext?: AICostContextLike;
  status?: AICostRecord['status'];
}
