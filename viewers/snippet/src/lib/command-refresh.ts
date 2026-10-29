type Callback = () => void;

const subscribers = new Set<Callback>();

export function notifyCommandRefresh(): void {
  for (const cb of subscribers) cb();
}

export function subscribeCommandRefresh(cb: Callback): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}
