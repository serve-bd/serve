"use client";

import * as React from "react";

/**
 * Database settings saved but not applied yet, per service. A module-level store so the
 * "Apply and restart" bar survives moving between settings sub-pages (each is its own route).
 */
const pending = new Map<string, string[]>();
const listeners = new Set<() => void>();
const EMPTY: string[] = [];

function emit() {
  for (const l of listeners) l();
}

export function addPendingApply(serviceId: string, what: string) {
  const list = pending.get(serviceId) ?? [];
  if (list.includes(what)) return;
  pending.set(serviceId, [...list, what]);
  emit();
}

export function clearPendingApply(serviceId: string) {
  pending.delete(serviceId);
  emit();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function usePendingApply(serviceId: string) {
  return React.useSyncExternalStore(
    subscribe,
    () => pending.get(serviceId) ?? EMPTY,
    () => EMPTY,
  );
}
