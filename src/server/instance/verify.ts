import { execFile } from "node:child_process";
import { docker } from "@/server/docker/client";
import { imageRepository } from "./manifest";

/*
 * Updates install only images the release workflow built and signed. The workflow signs each
 * release image with Sigstore's keyless signing: the signature names the workflow file and the
 * tag it ran for, and GitHub vouches for that. A copy of the image pushed by anyone else (a
 * stolen registry token, a changed tag) has no such signature and is refused.
 */

const ISSUER = "https://token.actions.githubusercontent.com";

/** The signer a release image must carry: the image workflow of `repository`, run for a tag. */
export function signerPattern(repository: string) {
  const repo = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^https://github\\.com/${repo}/\\.github/workflows/image\\.yml@refs/tags/v`;
}

/** The pulled image's digest in `repository` (repo@sha256:...), so the check and the install use the same bytes. */
export async function pulledDigest(image: string): Promise<string> {
  const info = await docker.getImage(image).inspect();
  const repo = imageRepository(image);
  const ref = (info.RepoDigests ?? []).find((d) => d.split("@")[0] === repo);
  if (!ref) throw new Error(`${image} has no registry digest, so its signature cannot be checked.`);
  return ref;
}

/** `image` pinned to its digest: repo:tag@sha256:... */
export function pinned(image: string, digestRef: string) {
  return `${image.split("@")[0]}@${digestRef.split("@")[1]}`;
}

/**
 * Checks the release signature of an image digest with cosign. Throws with cosign's reason when
 * the signature is missing or from another signer. SERVE_UPDATE_VERIFY=off skips the check (for
 * images built by hand).
 */
export async function verifyReleaseImage(digestRef: string, repository: string, log: (line: string) => void) {
  if (process.env.SERVE_UPDATE_VERIFY === "off") {
    log("Signature check skipped (SERVE_UPDATE_VERIFY=off).");
    return;
  }
  const args = ["verify", "--certificate-identity-regexp", signerPattern(repository), "--certificate-oidc-issuer", ISSUER, digestRef];
  await new Promise<void>((resolve, reject) => {
    execFile("cosign", args, { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return reject(new Error("cosign is not installed, so the release signature cannot be checked. Set SERVE_UPDATE_VERIFY=off to update without the check."));
      const reason = stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ") || error.message;
      reject(new Error(`The image is not signed by the ${repository} release workflow: ${reason}`));
    });
  });
  log(`Signature checked: signed by the ${repository} release workflow.`);
}
