import { generateKeyPairSync } from 'node:crypto';
import { createConfigSigner } from './app-config';

/**
 * Prints a new Ed25519 key pair for signing remote config: the private key on one line for the
 * CONFIG_SIGNING_KEY secret, and the public key the apps pin. Run it on a trusted machine; nothing is stored.
 */
const { privateKey } = generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
const signer = createConfigSigner(pem);
process.stdout.write(
  [
    `Key id: ${signer.keyId}`,
    '',
    'CONFIG_SIGNING_KEY (secret, store it in the secret manager only):',
    pem.replace(/\n/g, '\\n'),
    '',
    'Public key for the apps to pin:',
    signer.publicKeyPem.trim(),
    '',
  ].join('\n'),
);
