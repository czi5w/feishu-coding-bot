export type TaskId = string; // ULID, 26 chars

export const TASK_PHASES = [
  "queued",
  "planning",
  "editing",
  "testing",
  "done",
  "failed",
] as const;
export type Phase = (typeof TASK_PHASES)[number];

export interface TaskContext {
  task_id: TaskId;
  chat_id: string;
  user_id: string;
  user_name: string;
  instruction: string;
  message_id: string;
  ts: number; // unix seconds
}
