import * as crypto from 'crypto';

/**
 * Encryption Utility — AES-256-GCM
 *
 * Used to encrypt/decrypt per-site OpenAI API keys (BYOK).
 * The secret key is read from OPENAI_KEY_ENCRYPTION_SECRET env var.
 *
 * Format of ciphertext string:
 *   <iv_hex>:<authTag_hex>:<encrypted_hex>
 *
 * Security properties:
 *  - AES-256-GCM: authenticated encryption — detects tampering.
 *  - A fresh 12-byte IV is generated for every encryption call.
 *  - The 16-byte auth tag is stored alongside the ciphertext.
 *  - The master secret is never sent to the client.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV recommended for GCM

function getKey(): Buffer {
  const secret = process.env.OPENAI_KEY_ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      'Missing OPENAI_KEY_ENCRYPTION_SECRET environment variable. ' +
        'Generate a 32-character random string and set it in your .env file.',
    );
  }
  // Derive a 32-byte key from the secret using SHA-256
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypts an OpenAI API key using AES-256-GCM.
 * @param plaintext  The raw API key (e.g. "sk-...")
 * @returns          A colon-delimited string: "<iv>:<authTag>:<ciphertext>" (all hex)
 */
export function encryptApiKey(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a previously encrypted API key.
 * @param ciphertext  The colon-delimited string produced by encryptApiKey()
 * @returns           The original plaintext API key
 * @throws            Error if the ciphertext is tampered with or the key is wrong
 */
export function decryptApiKey(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted key format');
  }

  const [ivHex, authTagHex, encryptedHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const encrypted = Buffer.from(encryptedHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
