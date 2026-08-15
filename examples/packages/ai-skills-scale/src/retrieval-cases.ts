import type { SelectionCase } from './main.ts';
import { selectionCases } from './main.ts';

/** Hand-written tasks spanning unrelated domains; prompts do not copy skill descriptions. */
export const retrievalCases = [
  ...selectionCases,
  {
    id: 'app-insights',
    prompt: 'Add useful request, dependency, and failure telemetry to this web app in Azure.',
    expectedSkill: 'appinsights-instrumentation',
  },
  {
    id: 'arch-linux',
    prompt: 'My Arch machine stopped booting after a pacman upgrade; help me triage systemd.',
    expectedSkill: 'arch-linux-triage',
  },
  {
    id: 'aws-cost',
    prompt: 'Inspect our AWS infrastructure and open issues for concrete monthly cost reductions.',
    expectedSkill: 'aws-cost-optimize',
  },
  {
    id: 'azure-role',
    prompt:
      'Find the least-privileged Azure RBAC role that lets this identity read Key Vault secrets.',
    expectedSkill: 'azure-role-selector',
  },
  {
    id: 'excel',
    prompt: 'Read budget.xlsx and summarize the largest variances by department.',
    expectedSkill: 'convert-excel-to-md',
  },
  {
    id: 'word',
    prompt: 'Review proposal.docx and extract its deliverables and deadlines.',
    expectedSkill: 'convert-word-to-md',
  },
  {
    id: 'adr',
    prompt: 'Document why we chose Kafka over SQS as an architectural decision record.',
    expectedSkill: 'create-architectural-decision-record',
  },
  {
    id: 'csharp-async',
    prompt:
      'Review this C# async code for sync-over-async, cancellation, and ConfigureAwait mistakes.',
    expectedSkill: 'csharp-async',
  },
  {
    id: 'drawio',
    prompt:
      'Create a .drawio system architecture diagram with services, queues, and trust boundaries.',
    expectedSkill: 'draw-io-diagram-generator',
  },
  {
    id: 'email',
    prompt: "Draft a professional follow-up email to the customer after yesterday's demo.",
    expectedSkill: 'email-drafter',
  },
  {
    id: 'actions-security',
    prompt:
      'Audit this pull_request_target workflow for injection and excessive token permissions.',
    expectedSkill: 'github-actions-hardening',
  },
  {
    id: 'postmortem',
    prompt:
      'Turn the outage timeline into a blameless incident report with owners and action items.',
    expectedSkill: 'incident-postmortem',
  },
  {
    id: 'java-remove-param',
    prompt: 'Safely remove an obsolete parameter from this Java method and update every caller.',
    expectedSkill: 'java-refactoring-remove-parameter',
  },
  {
    id: 'next-intl',
    prompt: 'Add Japanese localization to this Next.js app that uses next-intl.',
    expectedSkill: 'next-intl-add-language',
  },
  {
    id: 'pdftk',
    prompt: 'Use the command line to merge two PDFs, rotate page three, and add a watermark.',
    expectedSkill: 'pdftk-server',
  },
  {
    id: 'pinecone',
    prompt: 'Build a multi-tenant RAG knowledge base with Pinecone namespaces and hybrid search.',
    expectedSkill: 'pinecone-rag',
  },
  {
    id: 'playwright',
    prompt: 'Generate a Playwright end-to-end test for the checkout and failed-payment scenario.',
    expectedSkill: 'playwright-generate-test',
  },
  {
    id: 'qdrant-quality',
    prompt:
      'Our Qdrant results have poor recall after quantization; diagnose relevance and reranking.',
    expectedSkill: 'qdrant-search-quality',
  },
  {
    id: 'enzyme-rtl',
    prompt: 'Migrate these React 18 Enzyme shallow tests to React Testing Library.',
    expectedSkill: 'react18-enzyme-to-rtl',
  },
  {
    id: 'ruff',
    prompt:
      'Run Ruff recursively, apply safe fixes, and work through the remaining Python findings.',
    expectedSkill: 'ruff-recursive-fix',
  },
  {
    id: 'secret-scanning',
    prompt:
      'Enable GitHub push protection, add a custom secret pattern, and triage existing alerts.',
    expectedSkill: 'secret-scanning',
  },
  {
    id: 'conversion-tracking',
    prompt:
      'Recover under-reported Facebook and TikTok purchases with server-side conversion events.',
    expectedSkill: 'server-side-conversion-tracking',
  },
  {
    id: 'sql-reconcile',
    prompt:
      'Compare production and staging SQL Server tables after the ETL migration for row drift.',
    expectedSkill: 'sql-server-table-reconciliation',
  },
  {
    id: 'terraform-set-diff',
    prompt:
      'Determine whether this AzureRM Terraform plan is only reordering a set or changing it.',
    expectedSkill: 'terraform-azurerm-set-diff-analyzer',
  },
  {
    id: 'vue-pinia',
    prompt: 'Write Vitest unit tests for this Vue 3 Pinia store using createTestingPinia.',
    expectedSkill: 'unit-test-vue-pinia',
  },
  {
    id: 'vscode-l10n',
    prompt: 'Localize this VS Code extension correctly, including commands and package metadata.',
    expectedSkill: 'vscode-ext-localization',
  },
  {
    id: 'winui',
    prompt: 'Port this UWP windowing and dispatcher code to WinUI 3 and the Windows App SDK.',
    expectedSkill: 'winui3-migration-guide',
  },
] as const satisfies readonly SelectionCase[];
