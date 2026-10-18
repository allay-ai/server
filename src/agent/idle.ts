/**
 * Folds a session once nobody has asked for a while, before the provider's prompt cache goes cold:
 * the next question then reads a summary and the newest exchanges instead of the whole long session at full price.
 * The timers live in this process, like the tool bridge; a restart only skips a fold.
 */
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** A new question on the thread: no fold under its feet. */
export const cancelIdleFold = (thread: string) => {
  clearTimeout(timers.get(thread));
  timers.delete(thread);
};

/** Starts the thread's quiet period over; fold runs if it ends with no new question. */
export const foldWhenIdle = (thread: string, ms: number, fold: () => Promise<void>) => {
  cancelIdleFold(thread);
  const timer = setTimeout(() => {
    timers.delete(thread);
    void fold();
  }, ms);
  timer.unref?.();
  timers.set(thread, timer);
};
