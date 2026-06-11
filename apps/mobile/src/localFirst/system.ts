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

let initPromise: Promise<void> | null = null;
let setupPromise: Promise<void> | null = null;
let connectAttempt: Promise<void> | null = null;

export function initPowerSync() {
  if (!initPromise) {
    initPromise = powersync.init();
  }
  return initPromise;
}

const CONNECT_TIMEOUT_MS = 45_000;

async function waitForConnectionSettled() {
  await Promise.race([
    powersync.waitForStatus((status) => status.connected || !status.connecting),
    new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error("PowerSync connect timed out")), CONNECT_TIMEOUT_MS);
    })
  ]).catch((error) => {
    console.warn("PowerSync connect wait failed", error);
  });
}

async function connectIfConfigured() {
  if (powersync.connected) return;

  if (powersync.connecting) {
    await waitForConnectionSettled();
    return;
  }

  if (!connectAttempt) {
    connectAttempt = (async () => {
      const connector = new SupabasePowerSyncConnector();
      const credentials = await connector.fetchCredentials();
      if (!credentials) {
        console.warn("PowerSync credentials unavailable — check EXPO_PUBLIC_POWERSYNC_URL and Supabase auth");
        return;
      }

      await Promise.race([
        powersync.connect(connector),
        new Promise<void>((_, reject) => {
          setTimeout(() => reject(new Error("PowerSync connect timed out")), CONNECT_TIMEOUT_MS);
        })
      ]);
    })().finally(() => {
      connectAttempt = null;
    });
  }

  await connectAttempt;
}

export function setupPowerSync() {
  if (!setupPromise) {
    setupPromise = initPowerSync();
  }

  return setupPromise.then(async () => {
    try {
      await connectIfConfigured();
    } catch (error) {
      console.warn("PowerSync connection failed", error);
    }
  });
}
