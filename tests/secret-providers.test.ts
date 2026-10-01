import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseSecretRef, providerAllows } from "@/lib/secret-providers";
import { REF } from "@/lib/refs";
import { infisicalPath, signV4 } from "@/server/secrets/providers";

describe("secret references", () => {
  it("parses provider, path and field", () => {
    expect(parseSecretRef("prod-vault.app/db:password")).toEqual({ provider: "prod-vault", path: "app/db", field: "password" });
    expect(parseSecretRef("doppler.DATABASE_URL")).toEqual({ provider: "doppler", path: "DATABASE_URL", field: null });
    expect(parseSecretRef("aws./prod/app/key")).toEqual({ provider: "aws", path: "/prod/app/key", field: null });
    expect(parseSecretRef("aws.prod/app.json:a.b")).toEqual({ provider: "aws", path: "prod/app.json", field: "a.b" });
    expect(parseSecretRef("nodot")).toBeNull();
    expect(parseSecretRef("v.path:")).toBeNull();
  });

  it("matches inside variable values", () => {
    const refs = [..."u=${{secrets.v.app/db:user}}&p=${{ secrets.aws./a/b }}".matchAll(REF)].map((m) => m[1]);
    expect(refs).toEqual(["secrets.v.app/db:user", "secrets.aws./a/b"]);
  });

  it("splits Infisical folders from the secret name", () => {
    expect(infisicalPath("DATABASE_URL")).toEqual({ folder: "/", name: "DATABASE_URL" });
    expect(infisicalPath("/backend/stripe/KEY")).toEqual({ folder: "/backend/stripe", name: "KEY" });
  });
});

describe("provider access", () => {
  const envProject = (id: string) => ({ e1: "p1", e2: "p1", e3: "p2" })[id];
  it("allows everything when nothing is picked", () => {
    expect(providerAllows({ projectIds: [], environmentIds: [] }, "p9", "e9", envProject)).toBe(true);
  });
  it("limits to picked projects, and to picked environments of those", () => {
    const access = { projectIds: ["p1", "p2"], environmentIds: ["e1"] };
    expect(providerAllows(access, "p1", "e1", envProject)).toBe(true);
    expect(providerAllows(access, "p1", "e2", envProject)).toBe(false);
    // No environment of p2 picked: all of p2's environments.
    expect(providerAllows(access, "p2", "e3", envProject)).toBe(true);
    expect(providerAllows(access, "p3", "e4", envProject)).toBe(false);
  });
});

describe("AWS Signature Version 4", () => {
  // The post-x-www-form-urlencoded case of AWS's published SigV4 test suite.
  it("matches the AWS test suite", () => {
    const headers = signV4({
      method: "POST",
      host: "example.amazonaws.com",
      path: "/",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "Param1=value1",
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=ff11897932ad3f4e8b18135d722051e5ac45fc38421b1da7b9d196a0fe09473a",
    );
  });

  it("signs the session token too", () => {
    const h = signV4({
      method: "POST",
      host: "ssm.eu-west-1.amazonaws.com",
      path: "/",
      headers: { "x-amz-target": "AmazonSSM.GetParameter" },
      body: "{}",
      region: "eu-west-1",
      service: "ssm",
      accessKeyId: "AK",
      secretAccessKey: crypto.randomBytes(8).toString("hex"),
      sessionToken: "tok",
      amzDate: "20260101T000000Z",
    });
    expect(h["x-amz-security-token"]).toBe("tok");
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token;x-amz-target");
  });
});
