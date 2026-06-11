import AsyncStorage from "@react-native-async-storage/async-storage";
import { SQLJSOpenFactory } from "@powersync/adapter-sql-js";
import { PowerSyncDatabase } from "@powersync/react-native";
import { fromByteArray, toByteArray } from "base64-js";
import { AppSchema } from "./schema";
import { SupabasePowerSyncConnector } from "./connector";

const databaseKey = "splitpay.powersync.sqljs";

const sqlJsFactory = new SQLJSOpenFactory({
  dbFilename: "splitpay.db",
  persister: {
    async readFile() {
      const stored = await AsyncStorage.getItem(databaseKey);
      return stored ? toByteArray(stored) : null;
    },
    async writeFile(data) {
      await AsyncStorage.setItem(databaseKey, fromByteArray(Uint8Array.from(data)));
    }
  }
});

export const powersync = new PowerSyncDatabase({
  schema: AppSchema,
  database: sqlJsFactory
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
