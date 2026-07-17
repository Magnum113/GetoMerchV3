import type { BackgroundJob } from "@/lib/jobs/types";

export type JobExecutionContext = {
  job: BackgroundJob;
  signal: AbortSignal;
  report: (progress: Record<string, unknown>, event?: string) => Promise<void>;
};
