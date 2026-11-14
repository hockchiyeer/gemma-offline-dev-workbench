const VERIFIER_PLAINTEXT = 'GEMMAVAULT_AES256_VERIFIED_V1';
const VERIFIER_AAD = 'gemmavault:security:primary';
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;
export const MIN_PASSPHRASE_LENGTH = 10;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function generateSaltBase64(length = 16): string {
  const salt = crypto.getRandomValues(new Uint8Array(length));
  return bytesToBase64(salt);
}

export async function deriveAesKey(
  passphrase: string,
  saltBase64: string,
  iterations = DEFAULT_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );

  const saltBytes = base64ToBytes(saltBase64);
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes.buffer as ArrayBuffer,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptText(
  plaintext: string,
  key: CryptoKey,
  aad?: string
): Promise<{ ivBase64: string; ciphertextBase64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encoded = encoder.encode(plaintext);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: iv.buffer as ArrayBuffer,
  };
  if (aad) {
    params.additionalData = encoder.encode(aad).buffer as ArrayBuffer;
  }
  const cipherBuffer = await crypto.subtle.encrypt(params, key, encoded);
  return {
    ivBase64: bytesToBase64(iv),
    ciphertextBase64: bytesToBase64(new Uint8Array(cipherBuffer)),
  };
}

export async function decryptText(
  ciphertextBase64: string,
  ivBase64: string,
  key: CryptoKey,
  aad?: string
): Promise<string> {
  const iv = base64ToBytes(ivBase64);
  const ciphertext = base64ToBytes(ciphertextBase64);
  const params: AesGcmParams = {
    name: 'AES-GCM',
    iv: iv.buffer as ArrayBuffer,
  };
  if (aad) {
    params.additionalData = new TextEncoder().encode(aad).buffer as ArrayBuffer;
  }
  const plainBuffer = await crypto.subtle.decrypt(
    params,
    key,
    ciphertext.buffer as ArrayBuffer
  );
  return new TextDecoder().decode(plainBuffer);
}

export async function createVerifier(key: CryptoKey): Promise<{
  verifierCipherBase64: string;
  verifierIvBase64: string;
}> {
  const { ivBase64, ciphertextBase64 } = await encryptText(
    VERIFIER_PLAINTEXT,
    key,
    VERIFIER_AAD
  );
  return {
    verifierCipherBase64: ciphertextBase64,
    verifierIvBase64: ivBase64,
  };
}

export async function verifyKeyAgainstToken(
  key: CryptoKey,
  verifierCipherBase64: string,
  verifierIvBase64: string
): Promise<boolean> {
  try {
    const result = await decryptText(verifierCipherBase64, verifierIvBase64, key, VERIFIER_AAD);
    return result === VERIFIER_PLAINTEXT;
  } catch {
    try {
      const legacy = await decryptText(verifierCipherBase64, verifierIvBase64, key);
      return legacy === VERIFIER_PLAINTEXT;
    } catch {
      return false;
    }
  }
}

export function evaluatePassphraseStrength(passphrase: string): {
  valid: boolean;
  label: string;
} {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    return {
      valid: false,
      label: `Minimum ${MIN_PASSPHRASE_LENGTH} characters required`,
    };
  }
  let classes = 0;
  if (/[a-z]/.test(passphrase)) classes++;
  if (/[A-Z]/.test(passphrase)) classes++;
  if (/[0-9]/.test(passphrase)) classes++;
  if (/[^a-zA-Z0-9]/.test(passphrase)) classes++;

  if (passphrase.length >= 16 && classes >= 3) {
    return { valid: true, label: 'Strong passphrase' };
  }
  if (passphrase.length >= 12 && classes >= 2) {
    return { valid: true, label: 'Good passphrase' };
  }
  return { valid: true, label: 'Acceptable (add length or symbols to strengthen)' };
}

export function isWebCryptoAvailable(): boolean {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined';
}
