import { createPublicKey, X509Certificate } from 'node:crypto';
import { compactVerify, decodeProtectedHeader } from 'jose';

/**
 * Verifies an App Store signed payload (a transaction or a server notification, both JWS with ES256 and an
 * x5c chain) offline: the chain must end at the pinned Apple root, each certificate must be signed by the
 * next and valid now, the leaf and intermediate must carry Apple's marker extensions, and the JWS must be
 * signed by the leaf. Nothing from the payload is trusted before all of that passes.
 */
export class AppleSignatureError extends Error {
  constructor(readonly reason: string) {
    super(`apple signature: ${reason}`);
    this.name = 'AppleSignatureError';
  }
}

/** DER of the extension OIDs Apple puts on the receipt-signing leaf (1.2.840.113635.100.6.11.1) and the WWDR intermediate (1.2.840.113635.100.6.2.1). */
const LEAF_OID = Buffer.from('060a2a864886f76364060b01', 'hex');
const INTERMEDIATE_OID = Buffer.from('060a2a864886f76364060201', 'hex');

export async function verifyAppleJws<T>(jws: string, rootCaPem: string, now = new Date()): Promise<T> {
  let header: { alg?: string; x5c?: unknown };
  try {
    header = decodeProtectedHeader(jws);
  } catch {
    throw new AppleSignatureError('malformed');
  }
  if (header.alg !== 'ES256') throw new AppleSignatureError('algorithm');
  if (!Array.isArray(header.x5c) || header.x5c.length !== 3 || !header.x5c.every((c) => typeof c === 'string')) throw new AppleSignatureError('chain');
  let chain: X509Certificate[];
  try {
    chain = (header.x5c as string[]).map((c) => new X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    throw new AppleSignatureError('chain');
  }
  const root = new X509Certificate(rootCaPem);
  const [leaf, intermediate, top] = chain;
  if (!top.raw.equals(root.raw)) throw new AppleSignatureError('untrusted_root');
  for (let i = 0; i < chain.length; i++) {
    const cert = chain[i];
    const issuer = chain[i + 1] ?? root;
    if (!cert.verify(issuer.publicKey) || cert.checkIssued(issuer) === false) throw new AppleSignatureError('chain');
    if (now < new Date(cert.validFrom) || now > new Date(cert.validTo)) throw new AppleSignatureError('expired');
  }
  if (!leaf.raw.includes(LEAF_OID) || !intermediate.raw.includes(INTERMEDIATE_OID)) throw new AppleSignatureError('not_apple');
  try {
    const { payload } = await compactVerify(jws, createPublicKey(leaf.publicKey.export({ type: 'spki', format: 'pem' })), { algorithms: ['ES256'] });
    return JSON.parse(new TextDecoder().decode(payload)) as T;
  } catch {
    throw new AppleSignatureError('signature');
  }
}

/** The fields of JWSTransactionDecodedPayload this service reads. */
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  purchaseDate: number;
  type: string;
  environment: 'Production' | 'Sandbox' | string;
  revocationDate?: number;
  appAccountToken?: string;
}

/** The fields of ResponseBodyV2DecodedPayload (App Store Server Notifications V2) this service reads. */
export interface AppleNotification {
  notificationType: string;
  subtype?: string;
  notificationUUID: string;
  data?: { bundleId?: string; environment?: string; signedTransactionInfo?: string };
}
