export type BackgroundTask = () => Promise<unknown> | unknown;
export type BackgroundTaskErrorHandler = (error: unknown) => void;

export class BackgroundTaskScheduler {
  constructor(private readonly onError: BackgroundTaskErrorHandler) {}

  run(task: BackgroundTask): Promise<void> {
    return Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (error) => {
          try {
            this.onError(error);
          } catch {
            // A terminal background boundary must never reject, even if logging fails.
          }
        },
      );
  }

  runAfterSettled(
    activeTask: Promise<unknown> | null,
    task: BackgroundTask,
  ): Promise<void> {
    return this.run(async () => {
      if (activeTask) {
        try {
          await activeTask;
        } catch {
          // The active task has its own caller; this boundary still runs the follow-up.
        }
      }
      await task();
    });
  }
}
