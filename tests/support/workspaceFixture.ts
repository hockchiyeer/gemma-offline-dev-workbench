import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const createdRoots: string[] = [];

/**
 * Creates a temporary realistic project directory with 9 indexed source/config files, plus
 * denied secret files (.env, .key) and .gitignored build artifacts to verify Workspace safety.
 */
export async function makeProject(): Promise<string> {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gemmavault-ws-'));
  const root = fs.realpathSync(rawRoot);
  createdRoots.push(root);

  const write = (rel: string, content: string) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  };

  // 9 counted files:
  write(
    'src/payments.ts',
    `import { markInvoicePaid } from './invoice';

const api_key = "some_test_gateway_value_123456";

export interface PaymentAttempt {
  invoiceId: string;
  attempt: number;
}

export async function retryFailedPayment(attempt: PaymentAttempt): Promise<boolean> {
  const backoffMs = Math.min(30_000, 500 * Math.pow(2, attempt.attempt));
  if (attempt.attempt >= 5) return false;
  await markInvoicePaid(attempt.invoiceId, backoffMs);
  return true;
}
`
  );

  write(
    'src/invoice.ts',
    `export interface InvoiceRecord {
  id: string;
  status: 'pending' | 'paid' | 'failed';
  retryCount: number;
}

export async function markInvoicePaid(id: string, delayMs: number): Promise<InvoiceRecord> {
  return {
    id,
    status: delayMs >= 0 ? 'paid' : 'failed',
    retryCount: 1,
  };
}

export function isRetryableInvoiceError(code: string): boolean {
  return code === 'TIMEOUT' || code === 'TRANSIENT_DECLINE';
}
`
  );

  write(
    'src/index.ts',
    `import { retryFailedPayment } from './payments';
import { isRetryableInvoiceError } from './invoice';

export async function runBillingCycle(invoiceId: string) {
  if (isRetryableInvoiceError('TIMEOUT')) {
    return retryFailedPayment({ invoiceId, attempt: 1 });
  }
  return false;
}
`
  );

  write(
    'src/billing/refunds.ts',
    `import { markInvoicePaid } from '../invoice';

export async function issueRefund(invoiceId: string, cents: number): Promise<{ refunded: boolean; cents: number }> {
  if (cents <= 0) return { refunded: false, cents: 0 };
  await markInvoicePaid(invoiceId, 0);
  return { refunded: true, cents };
}
`
  );

  write(
    'src/config.ts',
    `export const BILLING_CONFIG = {
  maxAttempts: 5,
  currency: 'USD',
};

const EMBEDDED_PEM = \`-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAtestprivatekeybody
-----END RSA PRIVATE KEY-----\`;

export const HAS_KEY = EMBEDDED_PEM.length > 0;
`
  );

  write(
    'src/utils/logger.ts',
    `export function logEvent(scope: string, message: string): string {
  return \`[\${scope}] \${message}\`;
}
`
  );

  write(
    'package.json',
    JSON.stringify({ name: 'sample-billing-app', version: '1.0.0', private: true }, null, 2)
  );

  write('README.md', '# Sample Billing App\n\nHandles invoices, failed payment retries, and refunds.\n');

  write('.gitignore', 'dist/\n*.log\n');

  // Denied / ignored files (must NEVER be counted in fileCount or returned by read/search):
  write('.env', 'API_SECRET=SUPER_SECRET_SHOULD_NEVER_LEAK\n');
  write('certs/signing.key', 'PRIVATE_KEY_MATERIAL_SUPER_SECRET\n');
  write('dist/bundle.js', 'console.log("compiled build artifact");\n');
  write('app.log', 'transient log line\n');

  return root;
}

export async function cleanupProjects(): Promise<void> {
  while (createdRoots.length > 0) {
    const dir = createdRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
