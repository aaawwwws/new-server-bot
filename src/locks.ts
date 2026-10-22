/**
 * 同じキーの処理を1つずつ順番に行う。ボタンの連打や、何人かが同時に押したときに、古い状態で上書きしないようにする。
 * Botは1つだけ動かす前提なので、Botの中で覚えておけば足りる
 */
export const createLock = () => {
  const queues = new Map<string, Promise<void>>();
  return async (key: string, task: () => Promise<void>): Promise<void> => {
    const current = (queues.get(key) ?? Promise.resolve()).then(task);
    const settled = current.catch(() => undefined);
    queues.set(key, settled);
    try {
      await current;
    } finally {
      if (queues.get(key) === settled) queues.delete(key);
    }
  };
};
