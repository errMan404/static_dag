export async function schedule({tasks, maxConcurrency, signal, runTask, active = new Map(), onError}) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  let failure;
  try {
    for (;;) {
      if (failure) throw failure;
      signal.throwIfAborted();
      for (const task of tasks) {
        if (active.size >= maxConcurrency) break;
        if (task.status !== 'pending' ||
            !task.dependencies.every(id => byId.get(id)?.status === 'done' && !active.has(id))) continue;
        task.status = 'running';
        task.startedAt = Date.now();
        const pending = Promise.resolve().then(() => runTask(task, signal))
          .catch(error => {
            failure ??= error;
            onError?.(error);
          }).finally(() => active.delete(task.id));
        active.set(task.id, pending);
      }
      if (!active.size) break;
      await Promise.race(active.values());
    }
  } finally {
    await Promise.allSettled(active.values());
  }
}
