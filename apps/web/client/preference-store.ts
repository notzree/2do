import { create } from "zustand";
import { persist, type PersistStorage } from "zustand/middleware";
import { defaults, readPreferences, storageKey, type Preferences } from "./preferences.ts";

// Keep the existing flat JSON format readable by tabs running the previous client.
const storage: PersistStorage<Preferences> = {
  getItem: () => ({ state: readPreferences() }),
  setItem(name, { state }) {
    try {
      localStorage.setItem(name, JSON.stringify(state));
    } catch {
      // Keep the in-memory change when browser storage is unavailable.
    }
  },
  removeItem(name) {
    try {
      localStorage.removeItem(name);
    } catch {
      // Browser storage can be disabled.
    }
  },
};

export const usePreferences = create<Preferences>()(
  persist(() => defaults, { name: storageKey, storage }),
);

export function subscribePreferenceChanges() {
  const sync = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) void usePreferences.persist.rehydrate();
  };
  window.addEventListener("storage", sync);
  return () => window.removeEventListener("storage", sync);
}
