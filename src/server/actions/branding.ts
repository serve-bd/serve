"use server";

import crypto from "node:crypto";
import { z } from "zod";
import { act, UserError } from "@/server/action";
import { requireInstanceAdmin } from "@/server/auth";
import { logActivity } from "@/server/activity";
import { getSetting, updateSettings } from "@/server/settings";
import { writeBrandAsset } from "@/server/branding";
import { type BrandAssetKind, type BrandingConfig, brandAssetKinds, checkBrandImage, cleanProductName, defaultBranding, normalizeHex } from "@/lib/branding";

const assetLabel: Record<BrandAssetKind, string> = { logo: "logo", logoDark: "dark mode logo", favicon: "favicon" };

async function currentConfig(): Promise<BrandingConfig> {
  return { ...defaultBranding, ...((await getSetting("branding")) ?? {}) };
}

const brandingInput = z.object({
  name: z.string().max(80),
  showName: z.boolean(),
  accent: z.string().max(20).nullable(),
});

/** Save the product name, "show name" and accent colour. Images are uploaded one by one. */
export async function saveBranding(input: z.input<typeof brandingInput>) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    const v = brandingInput.parse(input);
    const name = cleanProductName(v.name);
    if (!name) throw new UserError("Enter a product name.");
    let accent: string | null = null;
    if (v.accent?.trim()) {
      accent = normalizeHex(v.accent);
      if (!accent) throw new UserError("Enter the accent colour as a hex value, like #0a84ff.");
    }
    const config = await currentConfig();
    await updateSettings({ instanceName: name, branding: { ...config, showName: v.showName, accent } });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "branding.update", message: `Updated branding (${name})` });
    // The proxy's error pages carry the product name too.
    void import("@/server/proxy/nginx").then((m) => m.refreshErrorPages()).catch(() => {});
    return null;
  });
}

/** Upload a logo, dark mode logo or favicon. The type is checked from the bytes, not the file name. */
export async function uploadBrandImage(kind: BrandAssetKind, form: FormData) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    if (!brandAssetKinds.includes(kind)) throw new UserError("Unknown image.");
    const file = form.get("file");
    if (!(file instanceof File)) throw new UserError("Choose a file.");
    const buf = new Uint8Array(await file.arrayBuffer());
    const checked = checkBrandImage(kind, buf);
    if (checked.error !== null) throw new UserError(checked.error);
    const hash = crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16);
    await writeBrandAsset(kind, { mime: checked.mime, data: Buffer.from(buf).toString("base64"), hash });
    const config = await currentConfig();
    await updateSettings({ branding: { ...config, [kind]: { hash, mime: checked.mime } } });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "branding.update", message: `Uploaded a new ${assetLabel[kind]}` });
    return { hash };
  });
}

export async function removeBrandImage(kind: BrandAssetKind) {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    if (!brandAssetKinds.includes(kind)) throw new UserError("Unknown image.");
    await writeBrandAsset(kind, null);
    const config = await currentConfig();
    await updateSettings({ branding: { ...config, [kind]: null } });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "branding.update", message: `Removed the ${assetLabel[kind]}` });
    return null;
  });
}

/** Back to the default name, logo, icon and colour. */
export async function resetBranding() {
  return act(async () => {
    const ctx = await requireInstanceAdmin();
    await Promise.all(brandAssetKinds.map((k) => writeBrandAsset(k, null)));
    await updateSettings({ branding: null, instanceName: null as never });
    await logActivity({ userId: ctx.user.id, organizationId: ctx.org.id, action: "branding.update", message: "Reset branding to the defaults" });
    void import("@/server/proxy/nginx").then((m) => m.refreshErrorPages()).catch(() => {});
    return null;
  });
}
