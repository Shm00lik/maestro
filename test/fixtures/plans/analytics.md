# Churn Analytics Dashboard

## Context

Add a churn analytics dashboard with filters and CSV export.

### Task 1: Survey repo, auth & schema
Depends on: none
Agent: researcher
Owns: 
Acceptance: Findings on repo layout, auth model and schema are in the handoff note

Survey repo, auth & schema: see acceptance criteria.

### Task 2: Dashboard UX & states
Depends on: none
Agent: designer
Owns: docs/design/**
Acceptance: Wireframes cover loading, empty, error and filtered states

Dashboard UX & states: see acceptance criteria.

### Task 3: API contract (OpenAPI)
Depends on: T1
Agent: architect
Owns: docs/api/**
Acceptance: OpenAPI spec covers all churn and export endpoints

API contract (OpenAPI): see acceptance criteria.

### Task 4: Spike: churn query at scale
Depends on: T1
Agent: implementer
Owns: db/**
Acceptance: Churn query returns in under 500ms on the 10M-row sample

Spike: churn query at scale: see acceptance criteria.

### Task 5: Contract tests from the spec
Depends on: T3
Agent: test-author
Owns: test/contract/**
Acceptance: Contract tests exist for every endpoint in the spec and fail against a stub

Contract tests from the spec: see acceptance criteria.

### Task 6: API endpoints (test-first)
Depends on: T3, T4
Agent: implementer
Owns: src/api/**, test/api/**
Acceptance: all contract tests in test/contract pass; new unit tests pass

API endpoints (test-first): see acceptance criteria.

### Task 7: Dashboard pages on mock API
Depends on: T2, T3
Agent: implementer
Owns: src/web/**
Acceptance: Dashboard pages render against the mock API in all designed states

Dashboard pages on mock API: see acceptance criteria.

### Task 8: Wire FE to live API
Depends on: T6, T7
Agent: implementer
Owns: src/web/**
Acceptance: Dashboard loads real data from the live API with no mock calls

Wire FE to live API: see acceptance criteria.

### Task 9: Security review
Depends on: T6
Agent: code-reviewer
Owns: 
Acceptance: Review notes list findings by severity; no open high-severity issues

Security review: see acceptance criteria.

### Task 10: Load test churn endpoint
Depends on: T4, T6
Agent: qa
Owns: test/load/**
Acceptance: Churn endpoint sustains target load with p95 under 800ms

Load test churn endpoint: see acceptance criteria.

### Task 11: E2E: filters & CSV export
Depends on: T8
Agent: qa
Owns: test/e2e/**
Acceptance: E2E tests cover filters and CSV export and pass

E2E: filters & CSV export: see acceptance criteria.

### Task 12: Review, merge & hand off
Depends on: T5, T9, T10, T11
Agent: code-reviewer
Owns: 
Acceptance: Final review approved, branch merged and handoff note written

Review, merge & hand off: see acceptance criteria.

