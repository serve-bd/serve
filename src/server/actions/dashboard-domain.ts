"use server";

import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { applyDashboardFix, dashboardConnectionReport, DashboardFixError, type ConnectionReport } from "@/server/dashboard-connection";

export type { ConnectionReport, ConnectionStep } from "@/server/dashboard-connection";

/** Walks the whole path of a dashboard request, from DNS to the Serve process. */
export async function checkDashboardConnection() {
  return act(async (): Promise<ConnectionReport> => {
    await requireInstanceAdmin();
    return dashboardConnectionReport();
  });
}

/** One-click fixes offered by the connection checklist. */
export async function fixDashboardConnection(action: "dns" | "ingress" | "proxy") {
  return act(async () => {
    await requireInstanceAdmin();
    try {
      await applyDashboardFix(action);
    } catch (e) {
      throw e instanceof DashboardFixError ? new UserError(e.message) : e;
    }
    return null;
  });
}
