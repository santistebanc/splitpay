import { PowerSyncDatabase, WASQLiteOpenFactory } from "@powersync/web";
import { AppSchema } from "./schema";
import { SupabasePowerSyncConnector } from "./connector";

export const powersync = new PowerSyncDatabase({
  schema: AppSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: "splitpay.db",
    worker: "/@powersync/worker/WASQLiteDB.umd.js"
  }),
  sync: {
    worker: "/@powersync/worker/SharedSyncImplementation.umd.js"
  }
});

let setupPromise: Promise<void> | null = null;

export function setupPowerSync() {
  if (!setupPromise) {
    setupPromise = (async () => {
      await powersync.init();
      const connector = new SupabasePowerSyncConnector();
      const credentials = await connector.fetchCredentials();
      if (credentials) {
        void powersync.connect(connector).catch((error) => {
          console.warn("PowerSync connection failed", error);
        });
      }
    })();
  }

  return setupPromise;
}
