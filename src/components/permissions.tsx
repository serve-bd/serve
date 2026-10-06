"use client";

import * as React from "react";
import { cannotMessage, type Permission } from "@/lib/permissions";

type Access = { permissions: Permission[]; roleName: string; isAdmin: boolean };

const PermissionsContext = React.createContext<Access>({ permissions: [], roleName: "", isAdmin: false });

/** The signed-in member's permissions, for hiding what their role cannot do. The server checks again. */
export function PermissionsProvider({ value, children }: { value: Access; children: React.ReactNode }) {
  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export function useCan() {
  const { permissions } = React.useContext(PermissionsContext);
  return React.useCallback((p: Permission) => permissions.includes(p), [permissions]);
}

/** Tooltip text for a disabled control, or undefined when the role allows it. */
export function useCannot() {
  const can = useCan();
  return React.useCallback((p: Permission) => (can(p) ? undefined : cannotMessage(p)), [can]);
}
