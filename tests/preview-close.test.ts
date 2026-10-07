import { describe, expect, it, vi } from "vitest";

const removePreview = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/server/db", () => ({ db: {}, schema: {} }));
vi.mock("@/server/services/create", () => ({ queueDeployment: vi.fn() }));
vi.mock("@/server/services/previews", () => ({ removePreview, deployPreview: vi.fn(), commentOnPullRequest: vi.fn() }));

import { applyPullRequest } from "@/server/git/events";

const pr = { number: 7, branch: "feature", repository: "", title: null, sha: null, author: null };

describe("pull request events", () => {
  it("removes the preview of a closed pull request after previews were turned off", async () => {
    const service = { id: "s1", type: "app", parentServiceId: null, previewsEnabled: false } as never;
    expect(await applyPullRequest(service, { action: "close", pr })).toEqual({ removed: true });
    expect(removePreview).toHaveBeenCalledWith(service, 7);
  });

  it("does not deploy a preview while previews are off", async () => {
    const service = { id: "s1", type: "app", parentServiceId: null, previewsEnabled: false } as never;
    expect(await applyPullRequest(service, { action: "deploy", pr })).toEqual({ skipped: "Preview deployments are off" });
  });
});
