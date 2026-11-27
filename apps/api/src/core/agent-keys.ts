export async function stableInboxKey(parts: unknown[]) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function digestUuid(digest: string) {
  return (
    digest.slice(0, 8) +
    "-" +
    digest.slice(8, 12) +
    "-4" +
    digest.slice(13, 16) +
    "-8" +
    digest.slice(17, 20) +
    "-" +
    digest.slice(20, 32)
  );
}
