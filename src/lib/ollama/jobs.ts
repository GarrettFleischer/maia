/**
 * @fileoverview In-memory registry for Ollama-backed jobs (chat, embeddings, heartbeat).
 * @module lib/ollama/jobs
 *
 * Tracks active jobs so the header monitor can display them and issue stop requests.
 */

export type OllamaJobStatus = "running" | "completed" | "cancelled" | "failed";

/**
 * Public shape of a job as exposed to metrics consumers.
 */
export interface OllamaJobSnapshot {
  id: string;
  model: string;
  type: string;
  startedAt: string;
  status: OllamaJobStatus;
  canStop: boolean;
}

interface InternalOllamaJob extends OllamaJobSnapshot {
  cancel?: () => void;
}

const jobs: InternalOllamaJob[] = [];

/**
 * Registers a new Ollama job.
 * @param job - Snapshot fields plus optional cancel function.
 */
export function registerOllamaJob(
  job: OllamaJobSnapshot & { cancel?: () => void },
): void {
  const existingIndex = jobs.findIndex((j) => j.id === job.id);
  const next: InternalOllamaJob = { ...job };
  if (existingIndex >= 0) {
    jobs[existingIndex] = next;
  } else {
    jobs.push(next);
  }
}

/**
 * Marks a job as completed and no longer stoppable.
 * @param id - Job identifier
 */
export function completeOllamaJob(id: string): void {
  const job = jobs.find((j) => j.id === id);
  if (!job) return;
  job.status = "completed";
  job.canStop = false;
  job.cancel = undefined;
}

/**
 * Attempts to cancel a running job, updating its status and invoking its cancel function.
 * @param id - Job identifier
 * @returns True when a running job was found and a cancellation was requested.
 */
export function cancelOllamaJob(id: string): boolean {
  const job = jobs.find((j) => j.id === id);
  if (!job || !job.canStop) return false;
  job.status = "cancelled";
  const cancel = job.cancel;
  job.canStop = false;
  job.cancel = undefined;
  if (cancel) cancel();
  return true;
}

/**
 * Returns a snapshot of all jobs for metrics consumers.
 * The cancel handlers are not exposed.
 */
export function listOllamaJobs(): OllamaJobSnapshot[] {
  return jobs.map(({ cancel: _cancel, ...snapshot }) => ({ ...snapshot }));
}

/**
 * Testing helper: register a job directly with no cancel handler.
 * @param job - Job snapshot to add to the registry
 */
export function registerOllamaJobForTest(job: OllamaJobSnapshot): void {
  registerOllamaJob(job);
}

/**
 * Testing helper: clears the job registry between tests.
 */
export function clearOllamaJobsForTest(): void {
  jobs.splice(0, jobs.length);
}

