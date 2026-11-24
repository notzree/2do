import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from "jose";

type AccessConfig = {
	ACCESS_ISSUER: string;
	ACCESS_AUD: string;
	LOCAL_PLANNER: string;
};
let cachedKeys: { issuer: string; keys: JWTVerifyGetKey } | undefined;

function signingKeys(issuer: string) {
	if (cachedKeys?.issuer !== issuer) {
		cachedKeys = { issuer, keys: createRemoteJWKSet(new URL("/cdn-cgi/access/certs", issuer)) };
	}
	return cachedKeys.keys;
}

export async function identify(
	request: Request,
	config: AccessConfig,
	getKeys = signingKeys,
): Promise<string | Response> {
	const host = new URL(request.url).hostname;
	if (config.LOCAL_PLANNER === "enabled" && ["localhost", "127.0.0.1", "[::1]"].includes(host))
		return "dev:local";
	const issuer = config.ACCESS_ISSUER;
	if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer) || !config.ACCESS_AUD) {
		return Response.json({ error: "Cloudflare Access is not configured" }, { status: 503 });
	}
	const token = request.headers.get("Cf-Access-Jwt-Assertion");
	if (token) {
		try {
			const { payload } = await jwtVerify(token, getKeys(issuer), {
				issuer,
				audience: config.ACCESS_AUD,
				algorithms: ["RS256"],
				requiredClaims: ["sub", "exp"],
			});
			if (typeof payload.sub === "string" && payload.sub.length > 0)
				return issuer + "/" + payload.sub;
		} catch (error) {
			if (
				!(error instanceof errors.JOSEError) ||
				error instanceof errors.JWKSTimeout ||
				error instanceof errors.JWKSInvalid
			) {
				return Response.json({ error: "Access signing keys unavailable" }, { status: 503 });
			}
		}
	}
	return Response.json({ error: "Sign in with Cloudflare Access" }, { status: 401 });
}
