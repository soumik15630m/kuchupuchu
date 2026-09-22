/** Opening an IndexedDB database that is guaranteed to have its store.
 *
 * `indexedDB.open(name)` with no version creates an empty database at version
 * 1 if one does not exist. After that, opening at version 1 with the real
 * schema never fires `onupgradeneeded` -- the version already matches -- so
 * the object store is never created and every transaction throws
 * "One of the specified object stores was not found", permanently.
 *
 * That state is reachable without anyone doing anything strange: an upgrade
 * aborted by a quota error or a closed tab leaves the same shape. It was
 * found here when a restore decrypted correctly and then could not write a
 * single message, which is the worst possible moment to discover it.
 *
 * So the store is verified after opening, and a database missing it is
 * reopened one version higher to force the upgrade path to run. That repair
 * leaves the database *above* the version in the source, which is why the
 * first open tolerates a newer database instead of treating it as an error.
 *
 * Connections are cached per database. They used to be opened and closed
 * around every single get and put, which meant receiving one message cost
 * several full open/close cycles and restoring a backup cost two per message.
 * A cached handle has to give way when another tab upgrades the schema, hence
 * the `versionchange` listener below.
 */
const cache = new Map<string, Promise<IDBDatabase>>();

function open(
  name: string,
  version: number | undefined,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(name) : indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () =>
      reject(new Error(`${name} is open in another tab and cannot be upgraded`));
  });
}

function watch(name: string, db: IDBDatabase): IDBDatabase {
  // Another tab cannot upgrade while this connection is open, so hold it only
  // until asked to let go. Dropping the cache entry means the next call
  // reopens rather than using a connection that is closing underneath it.
  db.onversionchange = () => {
    cache.delete(name);
    db.close();
  };
  db.onclose = () => {
    cache.delete(name);
  };
  return db;
}

async function openVerified(
  name: string,
  version: number,
  store: string,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  let db: IDBDatabase;
  try {
    db = await open(name, version, upgrade);
  } catch (err) {
    // A database left at a higher version by an earlier self-repair. Opening
    // it as it stands is correct; downgrading is neither possible nor wanted.
    if ((err as DOMException | null)?.name !== "VersionError") throw err;
    db = await open(name, undefined, upgrade);
  }

  if (db.objectStoreNames.contains(store)) return watch(name, db);

  const next = db.version + 1;
  db.close();
  const repaired = await open(name, next, upgrade);
  if (!repaired.objectStoreNames.contains(store)) {
    repaired.close();
    throw new Error(`${name} could not be repaired`);
  }
  return watch(name, repaired);
}

export function openStore(
  name: string,
  version: number,
  store: string,
  upgrade: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  const existing = cache.get(name);
  if (existing) return existing;

  const opening = openVerified(name, version, store, upgrade).catch((err) => {
    // A failed open must not be cached, or every later call replays the
    // failure without ever retrying.
    cache.delete(name);
    throw err;
  });
  cache.set(name, opening);
  return opening;
}

/** Drops the cached handle so a database can be deleted. `deleteDatabase`
 * blocks indefinitely while any connection is open, which is exactly what a
 * cache creates -- so the sign-out wipe has to call this first. */
export function closeStore(name: string): void {
  const entry = cache.get(name);
  cache.delete(name);
  entry?.then((db) => db.close()).catch(() => {});
}

export function closeAllStores(): void {
  for (const name of [...cache.keys()]) closeStore(name);
}
