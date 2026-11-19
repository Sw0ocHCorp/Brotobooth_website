/** De quoi fabriquer, dans les tests, des jetons comme en émet Cloudflare Access, signés par une clé de test. */

export const TEAM = "equipe-test.cloudflareaccess.com";
export const AUD = "a".repeat(64);
export const NOW = "2026-11-20T10:00:00.000Z";
export const NOW_S = Date.parse(NOW) / 1000;
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };

export type Signer = { kid: string; privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };

export const base64url = (bytes: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(bytes as ArrayBuffer)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const encode = (value: unknown): string => base64url(new TextEncoder().encode(JSON.stringify(value)));

export async function newSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(RSA, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

/**
 * Un jeton comme en émet Access : valide pour `AUD` et `TEAM` à l'instant `at` (en secondes, `NOW_S` par défaut), sauf ce
 * que `claims` ou `header` changent.
 */
export async function tokenFrom(signer: Signer, claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}, at = NOW_S): Promise<string> {
  const head = encode({ alg: "RS256", kid: signer.kid, typ: "JWT", ...header });
  const body = encode({ aud: [AUD], iss: `https://${TEAM}`, iat: at - 60, nbf: at - 60, exp: at + 3600, type: "app", ...claims });
  const signature = await crypto.subtle.sign(RSA.name, signer.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${base64url(signature)}`;
}
