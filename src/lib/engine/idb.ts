// Minimal promise wrapper around IndexedDB for job persistence.

const DB = 'grabbit';
const STORE = 'jobs';
let dbp: Promise<IDBDatabase> | undefined;

function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then(
    (d) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r ? r.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export interface StoredJob<J = unknown, R = unknown> {
  id: string;
  job: J;
  resume?: R;
}

export const idbAll = <J, R>() => tx<StoredJob<J, R>[]>('readonly', (s) => s.getAll() as IDBRequest<StoredJob<J, R>[]>).then((r) => r ?? []);
export const idbPut = (v: StoredJob) => tx('readwrite', (s) => s.put(v)).then(() => {});
export const idbDelete = (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => {});
