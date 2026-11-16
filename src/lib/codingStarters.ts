export type CodingStarterCategory =
  | 'apis'
  | 'frontend'
  | 'backend'
  | 'data'
  | 'testing'
  | 'ops'
  | 'refactoring';

export interface CodingStarter {
  id: string;
  category: CodingStarterCategory;
  label: string;
  stack: string;
  prompt: string;
  keywords: string[];
}

export const CODING_STARTER_CATEGORIES: Array<{
  id: 'all' | CodingStarterCategory;
  label: string;
}> = [
  { id: 'all', label: 'All Tasks' },
  { id: 'apis', label: 'APIs & Design' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend' },
  { id: 'data', label: 'Data & SQL' },
  { id: 'testing', label: 'Testing & Debug' },
  { id: 'ops', label: 'Security & Ops' },
  { id: 'refactoring', label: 'Refactor & AI' },
];

export const CODING_STARTERS: CodingStarter[] = [
  {
    id: 'rest-rpc-api',
    category: 'apis',
    label: 'Design REST / RPC API',
    stack: 'TypeScript · Validation',
    prompt:
      'Design a clean, type-safe API module with schema validation, cursor pagination, and structured error handling in TypeScript.',
    keywords: ['rest', 'rpc', 'http', 'endpoint', 'schema', 'zod', 'pagination', 'contract'],
  },
  {
    id: 'webhook-idempotency',
    category: 'apis',
    label: 'Webhook & Idempotency Handler',
    stack: 'HTTP · Queues',
    prompt:
      'Build an idempotent webhook receiver with HMAC signature verification, replay protection, and dead-letter retry handling.',
    keywords: ['webhook', 'hmac', 'signature', 'idempotent', 'retry', 'queue', 'events'],
  },
  {
    id: 'system-architecture',
    category: 'apis',
    label: 'System Architecture & Tradeoffs',
    stack: 'Distributed Systems',
    prompt:
      'Compare a modular monolith vs. event-driven services for this feature, covering data ownership, caching, consistency boundaries, and failure modes.',
    keywords: ['architecture', 'microservices', 'monolith', 'cache', 'kafka', 'tradeoffs', 'scale'],
  },
  {
    id: 'accessible-react-ui',
    category: 'frontend',
    label: 'Accessible React Component',
    stack: 'React · TypeScript · ARIA',
    prompt:
      'Build a keyboard-navigable, WCAG AA compliant React + TypeScript component with clean state management, focus handling, and responsive Tailwind styling.',
    keywords: ['react', 'ui', 'a11y', 'aria', 'keyboard', 'tailwind', 'component', 'frontend'],
  },
  {
    id: 'optimistic-state-sync',
    category: 'frontend',
    label: 'Optimistic UI & State Sync',
    stack: 'React · Async State',
    prompt:
      'Implement optimistic UI mutations with rollback on server failure, AbortController cancellation, and race-condition protection.',
    keywords: ['state', 'optimistic', 'fetch', 'abort', 'sync', 'cache', 'mutation'],
  },
  {
    id: 'frontend-performance',
    category: 'frontend',
    label: 'Frontend Performance Audit',
    stack: 'Web Vitals · Bundling',
    prompt:
      'Diagnose unnecessary React re-renders, request waterfalls, and bundle bloat, and propose concrete memoization, virtualization, and code-splitting fixes.',
    keywords: ['performance', 'render', 'bundle', 'vitals', 'lazy', 'memo', 'lighthouse'],
  },
  {
    id: 'python-async-worker',
    category: 'backend',
    label: 'Python Async Worker',
    stack: 'Python · asyncio',
    prompt:
      'Write an asyncio worker queue in Python with graceful shutdown, backpressure, retry backoff, and bounded concurrency.',
    keywords: ['python', 'asyncio', 'worker', 'queue', 'concurrency', 'semaphore'],
  },
  {
    id: 'rust-error-handling',
    category: 'backend',
    label: 'Rust Error Handling',
    stack: 'Rust',
    prompt:
      'Demonstrate idiomatic Rust error handling with custom Error enums, contextual propagation, and zero panics across async boundaries.',
    keywords: ['rust', 'error', 'result', 'thiserror', 'anyhow', 'enum', 'panic'],
  },
  {
    id: 'go-concurrent-pipeline',
    category: 'backend',
    label: 'Go Concurrent Pipeline',
    stack: 'Go · Channels',
    prompt:
      'Build a context-aware Go worker pool using fan-out/fan-in channels, per-task timeouts, and clean error propagation without goroutine leaks.',
    keywords: ['go', 'golang', 'goroutine', 'channel', 'context', 'worker', 'pipeline'],
  },
  {
    id: 'auth-rbac-middleware',
    category: 'backend',
    label: 'Auth & RBAC Middleware',
    stack: 'Auth · Sessions · CSRF',
    prompt:
      'Implement session/JWT verification, CSRF protection, rate limiting, and role-based access control middleware with secure defaults.',
    keywords: ['auth', 'jwt', 'rbac', 'session', 'csrf', 'middleware', 'permissions'],
  },
  {
    id: 'optimize-sql-query',
    category: 'data',
    label: 'Optimize SQL Query',
    stack: 'PostgreSQL · Indexes',
    prompt:
      'Write an indexed, injection-safe SQL query using CTEs or window functions and explain how to read its EXPLAIN ANALYZE execution plan.',
    keywords: ['sql', 'postgres', 'index', 'query', 'explain', 'cte', 'window', 'database'],
  },
  {
    id: 'zero-downtime-migration',
    category: 'data',
    label: 'Zero-Downtime Schema Migration',
    stack: 'SQL · Expand & Contract',
    prompt:
      'Plan a backwards-compatible expand-and-contract database migration with safe nullable columns, batched backfills, and concurrent index creation.',
    keywords: ['migration', 'schema', 'alter', 'lock', 'backfill', 'postgres', 'downtime'],
  },
  {
    id: 'etl-validation-pipeline',
    category: 'data',
    label: 'ETL & Data Validation Pipeline',
    stack: 'Ingestion · Streaming',
    prompt:
      'Design a resumable data ingestion pipeline with strict schema validation, idempotent upserts, deduplication, and dead-letter quarantine.',
    keywords: ['etl', 'csv', 'json', 'parquet', 'pipeline', 'validation', 'dedupe'],
  },
  // Testing & Debug (18 comprehensive templates)
  {
    id: 'unit-integration-tests',
    category: 'testing',
    label: 'Unit & Integration Test Suite',
    stack: 'Vitest · Node Test',
    prompt:
      'Generate thorough unit and integration tests covering happy paths, boundary conditions, deterministic mocks, and failure recovery.',
    keywords: ['test', 'unit', 'integration', 'vitest', 'jest', 'mock', 'coverage', 'assert'],
  },
  {
    id: 'root-cause-debugging',
    category: 'testing',
    label: 'Root-Cause Bug Triage',
    stack: 'Debugging · Diagnostics',
    prompt:
      'Walk through a systematic bug triage: minimal reproduction, state/timing isolation, race-condition checks, and a targeted regression test.',
    keywords: ['debug', 'bug', 'triage', 'stacktrace', 'race', 'memory', 'leak', 'regression'],
  },
  {
    id: 'playwright-e2e-spec',
    category: 'testing',
    label: 'Playwright E2E Test Spec',
    stack: 'Playwright · Browser',
    prompt:
      'Write a resilient end-to-end Playwright test using accessible role locators, network route stubs, and deterministic assertions without arbitrary sleeps.',
    keywords: ['playwright', 'e2e', 'browser', 'locator', 'cucumber', 'bdd', 'selenium'],
  },
  {
    id: 'robot-framework-suite',
    category: 'testing',
    label: 'Robot Framework Automation Suite',
    stack: 'Robot Framework · Python',
    prompt:
      'Generate keyword-driven automated tests, reusable keywords, test suites, and execution reports.',
    keywords: ['robot', 'framework', 'python', 'keyword', 'automation', 'acceptance', 'test'],
  },
  {
    id: 'cypress-e2e-suite',
    category: 'testing',
    label: 'Cypress E2E Automation Suite',
    stack: 'Cypress · JavaScript',
    prompt:
      'Create browser end-to-end tests with fixtures, intercepts, custom commands, and deterministic assertions.',
    keywords: ['cypress', 'javascript', 'e2e', 'browser', 'intercept', 'fixture', 'command'],
  },
  {
    id: 'selenium-webdriver-automation',
    category: 'testing',
    label: 'Selenium WebDriver Automation',
    stack: 'Selenium · Java/Python',
    prompt:
      'Generate cross-browser UI automation with Page Object Model, explicit waits, and reusable locators.',
    keywords: ['selenium', 'webdriver', 'java', 'python', 'pom', 'pageobject', 'browser', 'ui'],
  },
  {
    id: 'java-testng-suite',
    category: 'testing',
    label: 'Java TestNG Automation Suite',
    stack: 'TestNG · Java',
    prompt:
      'Generate test classes, annotations, data providers, groups, parallel execution, and assertions.',
    keywords: ['testng', 'java', 'annotations', 'dataprovider', 'parallel', 'assertions'],
  },
  {
    id: 'java-cucumber-bdd',
    category: 'testing',
    label: 'Java Cucumber BDD Framework',
    stack: 'Cucumber · Java',
    prompt:
      'Generate Gherkin feature files, Given-When-Then scenarios, step definitions, and test runners.',
    keywords: ['cucumber', 'bdd', 'java', 'gherkin', 'scenario', 'steps', 'feature'],
  },
  {
    id: 'pytest-automation-suite',
    category: 'testing',
    label: 'Pytest Automation Suite',
    stack: 'Pytest · Python',
    prompt:
      'Generate fixtures, parametrized tests, mocks, assertions, and reusable test configurations.',
    keywords: ['pytest', 'python', 'fixture', 'parametrize', 'mock', 'assert'],
  },
  {
    id: 'karate-api-framework',
    category: 'testing',
    label: 'Karate API Test Framework',
    stack: 'Karate · Java/Gherkin',
    prompt:
      'Generate REST API, SOAP, GraphQL, authentication, and JSON/XML validation tests.',
    keywords: ['karate', 'api', 'rest', 'soap', 'graphql', 'validation', 'json'],
  },
  {
    id: 'junit-5-testing-suite',
    category: 'testing',
    label: 'JUnit 5 Testing Suite',
    stack: 'JUnit 5 · Java',
    prompt:
      'Create Java unit and integration tests with lifecycle hooks, parameterized tests, and assertions.',
    keywords: ['junit', 'java', 'unit', 'lifecycle', 'parameterized', 'assert'],
  },
  {
    id: 'postman-api-automation',
    category: 'testing',
    label: 'Postman API Automation',
    stack: 'Postman · JavaScript',
    prompt:
      'Generate API collections, pre-request scripts, response assertions, and automated execution.',
    keywords: ['postman', 'api', 'javascript', 'collection', 'prerequest', 'script', 'Newman'],
  },
  {
    id: 'rest-assured-api-testing',
    category: 'testing',
    label: 'REST Assured API Testing',
    stack: 'REST Assured · Java',
    prompt:
      'Create automated REST API tests covering HTTP methods, authentication, schemas, and response validation.',
    keywords: ['restassured', 'java', 'api', 'rest', 'schema', 'validation', 'http'],
  },
  {
    id: 'jest-testing-suite',
    category: 'testing',
    label: 'Jest Testing Suite',
    stack: 'Jest · JavaScript',
    prompt:
      'Generate JavaScript unit tests, mocks, snapshots, asynchronous tests, and coverage reports.',
    keywords: ['jest', 'javascript', 'unit', 'mock', 'snapshot', 'async', 'coverage'],
  },
  {
    id: 'appium-mobile-automation',
    category: 'testing',
    label: 'Appium Mobile Automation',
    stack: 'Appium · Java/Python',
    prompt:
      'Generate Android and iOS mobile automation tests with reusable test flows.',
    keywords: ['appium', 'mobile', 'android', 'ios', 'automation', 'native', 'app'],
  },
  {
    id: 'jmeter-performance-testing',
    category: 'testing',
    label: 'JMeter Performance Testing',
    stack: 'JMeter · Java',
    prompt:
      'Generate load-test plans, concurrent user simulations, throughput measurements, and performance reports.',
    keywords: ['jmeter', 'performance', 'load', 'stress', 'throughput', 'threads', 'benchmark'],
  },
  {
    id: 'owasp-security-testing',
    category: 'testing',
    label: 'OWASP Security Testing',
    stack: 'OWASP ZAP · Security',
    prompt:
      'Generate web application security tests covering authentication, authorization, injection, and common vulnerabilities.',
    keywords: ['owasp', 'zap', 'security', 'vulnerability', 'injection', 'auth', 'penetration'],
  },
  {
    id: 'regression-flaky-analysis',
    category: 'testing',
    label: 'Regression & Flaky Test Analysis',
    stack: 'Multi-language · QA',
    prompt:
      'Identify regression risks, unstable tests, timing dependencies, and generate reliable regression test cases.',
    keywords: ['regression', 'flaky', 'unstable', 'timing', 'qa', 'reliability', 'tests'],
  },
  // Security & Ops
  {
    id: 'docker-cicd-pipeline',
    category: 'ops',
    label: 'Multi-Stage Docker & CI/CD',
    stack: 'Docker · GitHub Actions',
    prompt:
      'Create a minimal, non-root multi-stage Dockerfile and a fast CI workflow with dependency caching, typechecking, tests, and vulnerability checks.',
    keywords: ['docker', 'container', 'ci', 'cd', 'github', 'actions', 'deploy', 'linux'],
  },
  {
    id: 'owasp-security-audit',
    category: 'ops',
    label: 'OWASP Security Review',
    stack: 'AppSec · Hardening',
    prompt:
      'Audit this code for injection flaws, SSRF, path traversal, broken access control, secret leakage, and unsafe deserialization with concrete fixes.',
    keywords: ['security', 'owasp', 'xss', 'sqli', 'ssrf', 'audit', 'secrets', 'hardening'],
  },
  {
    id: 'observability-telemetry',
    category: 'ops',
    label: 'Structured Logging & Tracing',
    stack: 'OpenTelemetry · Metrics',
    prompt:
      'Instrument an API service with structured JSON logs, correlation IDs, PII/secret redaction, and OpenTelemetry spans without noisy overhead.',
    keywords: ['logging', 'otel', 'opentelemetry', 'tracing', 'metrics', 'prometheus', 'slo'],
  },
  // Refactor & AI
  {
    id: 'refactor-legacy-module',
    category: 'refactoring',
    label: 'Refactor Legacy Code Safely',
    stack: 'Modularization · Clean Code',
    prompt:
      'Break down a tightly coupled legacy module into pure, testable functions using characterization tests and incremental extraction without changing behavior.',
    keywords: ['refactor', 'legacy', 'clean', 'extract', 'coupling', 'solid', 'maintainable'],
  },
  {
    id: 'code-review-audit',
    category: 'refactoring',
    label: 'Code Review & Edge-Case Audit',
    stack: 'PR Review · Correctness',
    prompt:
      'Review this implementation as a senior engineer: flag subtle correctness bugs, concurrency hazards, unhandled errors, and simplify unnecessary complexity.',
    keywords: ['review', 'pr', 'edge', 'audit', 'complexity', 'bugs', 'readability'],
  },
  {
    id: 'ai-rag-eval-workflow',
    category: 'refactoring',
    label: 'LLM Prompt & Eval Harness',
    stack: 'JSON Schema · Evals',
    prompt:
      'Design a structured-output LLM workflow with strict JSON schema validation, grounded citations, token budgeting, and deterministic evaluation cases.',
    keywords: ['ai', 'llm', 'rag', 'prompt', 'eval', 'json', 'embeddings', 'agent'],
  },
];

export function filterCodingStarters(
  category: 'all' | CodingStarterCategory,
  query: string
): CodingStarter[] {
  const q = query.trim().toLowerCase();
  return CODING_STARTERS.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (!q) return true;
    const haystack = `${item.label} ${item.stack} ${item.prompt} ${item.keywords.join(' ')}`.toLowerCase();
    return q.split(/\s+/).every((term) => haystack.includes(term));
  });
}
