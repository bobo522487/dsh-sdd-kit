# Feature Specification: [FEATURE NAME]

> Describe **what** the system must do and **what it must NOT do**. Keep implementation details (SQL, frameworks, internal classes) out of this document.

## 1. User Story & Intent
- **As a** [role], **I want** [capability], **so that** [measurable outcome].

## 2. Functional Requirements (EARS Format)
Write every requirement using EARS syntax so it maps 1-to-1 to automated tests:
- `REQ-01`: **WHEN** [event or precondition] **THE SYSTEM SHALL** [observable, verifiable response].
- `REQ-02`: **IF** [error or edge condition] **THE SYSTEM SHALL** [safe failure or fallback behavior].

## 3. Non-Goals & Hard Constraints (业务禁区)
Explicitly declare what is **out of scope** and what is **forbidden**:
- **Out of Scope**: [features intentionally excluded from this change]
- **Forbidden Behavior**: [e.g., no duplicate charges on webhook retry, no plaintext secrets in logs, no breaking change to existing `/v1/*` payloads]
- **Performance / Compatibility Bounds**: [latency, rate limits, backward-compatibility rules]

## 4. Acceptance Criteria
- [ ] `AC-01`: [Concrete test case or deterministic check proving `REQ-01`]
- [ ] `AC-02`: [Concrete negative/edge test case proving `REQ-02` and constraints]
