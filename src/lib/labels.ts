/** Short human labels for deployment triggers. */
export const triggerShort: Record<string, string> = {
  create: "Initial deploy",
  manual: "Manual",
  redeploy: "Redeploy",
  rollback: "Rollback",
  webhook: "Git push",
  "deploy-hook": "Deploy hook",
  api: "API",
};

export const triggerText = (t: string) => triggerShort[t] ?? t;
