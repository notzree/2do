import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { ConnectorKind, Directions } from "../interfaces/connectors.ts";

export interface GoogleSecrets {
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CONNECTOR_ORIGIN?: string;
  GOOGLE_TOKEN_KEY?: string;
  GMAIL_PUBSUB_TOPIC?: string;
  GMAIL_PUSH_SERVICE_ACCOUNT?: string;
  GMAIL_PUSH_SUBSCRIPTION?: string;
}
export function configured(env: GoogleSecrets, kind: ConnectorKind) {
  return !!(
    env.GOOGLE_CLIENT_ID &&
    env.GOOGLE_CLIENT_SECRET &&
    env.GOOGLE_CONNECTOR_ORIGIN &&
    env.GOOGLE_TOKEN_KEY &&
    (kind !== "gmail" ||
      (env.GMAIL_PUBSUB_TOPIC && env.GMAIL_PUSH_SERVICE_ACCOUNT && env.GMAIL_PUSH_SUBSCRIPTION))
  );
}
export function scopes(kind: ConnectorKind, options: Directions) {
  const prefix = "https://www.googleapis.com/auth/";
  const features =
    kind === "gmail"
      ? ["gmail.readonly"]
      : [
          ...(options.importEvents ? ["calendar.events.readonly"] : []),
          ...(options.exportEvents
            ? ["calendar.app.created", "calendar.calendarlist.readonly"]
            : []),
        ];
  return features.map((scope) => prefix + scope);
}
export function oauth(env: GoogleSecrets, kind: ConnectorKind) {
  return new OAuth2Client({
    transporterOptions: { timeout: 15_000, fetchImplementation: (url, init) => fetch(url, init) },
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: new URL("/api/connections/" + kind + "/callback", env.GOOGLE_CONNECTOR_ORIGIN)
      .href,
  });
}
export async function consent(client: OAuth2Client, requested: string[]) {
  const state = crypto.randomUUID();
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  return {
    state,
    codeVerifier,
    url: client.generateAuthUrl({
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      access_type: "offline",
      prompt: "consent",
      scope: ["openid", "email", ...requested],
    }),
  };
}
async function key(raw: string) {
  return crypto.subtle.importKey("raw", Buffer.from(raw, "base64"), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}
export async function seal(value: string, raw: string, context: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
    await key(raw),
    new TextEncoder().encode(value),
  );
  return Buffer.concat([iv, new Uint8Array(data)]).toString("base64");
}
export async function unseal(value: string, raw: string, context: string) {
  const bytes = Buffer.from(value, "base64");
  const data = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: bytes.subarray(0, 12),
      additionalData: new TextEncoder().encode(context),
    },
    await key(raw),
    bytes.subarray(12),
  );
  return new TextDecoder().decode(data);
}
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export async function verifiedGoogleIdentity(token: string, audience: string, keys = googleKeys) {
  const { payload } = await jwtVerify(token, keys, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
    algorithms: ["RS256"],
    requiredClaims: ["exp", "sub", "email", "email_verified"],
  });
  if (payload.email_verified !== true || typeof payload.email !== "string" || !payload.sub)
    throw new Error("Unverified Google identity");
  return { email: payload.email.toLowerCase(), sub: payload.sub };
}
