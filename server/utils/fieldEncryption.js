import crypto from 'crypto';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

// Field-level encryption for data that must be stored but never shown in full — a
// restaurant's bank account number (Restaurant.payoutAccount). AES-256-GCM: authenticated, so
// a tampered value fails to decrypt instead of decrypting to garbage.
//
// Stored form: "v1:<iv>:<authTag>:<ciphertext>" (base64 parts). The version prefix is what makes
// a future key rotation possible — a v2 key can be introduced while v1 values still decrypt.
// A fresh random IV per value, so the same account number never encrypts to the same string.
//
// The key is DATA_ENCRYPTION_KEY: 32 random bytes, base64. Required in production (config/env.js
// refuses to boot without it). Never logged; lose it and every stored number is unreadable.

const VERSION = 'v1';

const key = () => {
  if (!env.DATA_ENCRYPTION_KEY) {
    throw new ApiError(503, 'ENCRYPTION_NOT_CONFIGURED', 'Secure storage is not configured on this server');
  }
  return Buffer.from(env.DATA_ENCRYPTION_KEY, 'base64');
};

export const encryptField = (plaintext) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(':');
};

export const decryptField = (stored) => {
  const [version, iv, tag, ciphertext] = String(stored ?? '').split(':');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new ApiError(500, 'DECRYPTION_FAILED', 'Stored value is not in a recognised encrypted format');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(500, 'DECRYPTION_FAILED', 'Stored value could not be decrypted');
  }
};
