import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

// The module reads these at import time; no database connection is made.
process.env.BETTER_AUTH_SECRET = "test-secret-for-github-app-state";
process.env.DATABASE_URL = "postgres://test@127.0.0.1:1/test";
const { appJwt, repoFullName, signState, verifyState } = await import("@/server/git/github-app");

describe("github app", () => {
  it("round-trips signed state and rejects tampering", () => {
    const token = signState({ credentialId: "c1", organizationId: "o1", userId: "u1" });
    expect(verifyState(token)).toMatchObject({ credentialId: "c1", organizationId: "o1", userId: "u1" });
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ credentialId: "c1", organizationId: "evil", userId: "u1", exp: Date.now() + 1e6 })).toString("base64url");
    expect(verifyState(`${forged}.${sig}`)).toBeNull();
    expect(verifyState(`${payload}.x`)).toBeNull();
    expect(verifyState(null)).toBeNull();
  });

  it("signs an RS256 JWT GitHub can verify", () => {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwt = appJwt(12345, privateKey.export({ type: "pkcs1", format: "pem" }).toString());
    const [h, p, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(claims.iss).toBe("12345");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, s, "base64url")).toBe(true);
  });

  it("normalizes repository URLs", () => {
    expect(repoFullName("https://github.com/Acme/Web.git")).toBe("acme/web");
    expect(repoFullName("git@github.com:acme/web.git")).toBe("acme/web");
    expect(repoFullName("https://www.github.com/acme/web/")).toBe("acme/web");
  });
});
