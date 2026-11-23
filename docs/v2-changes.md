# CSF_v2: corrections to the published contracts

`CSF_vLatest.sol` is the source published with the [article](https://doi.org/10.1108/SASBE-08-2024-0291). It stays byte-identical, so the paper's results remain reproducible and the source-integrity check still holds. `CSF_v2.sol` is a corrected copy. It keeps the same two contracts, roles and four-stage workflow, and it fixes faults found in a review of the published source on 23 November 2026.

Every change has a test in `test/v2-fixes.test.js`. The tests pass against `CSF_v2.sol`. `npm run test:baseline-faults` runs the same tests against `CSF_vLatest.sol`, where every one is expected to fail, which shows each fault is real.

Sources for the security checks: the Solidity 0.8.26 documentation, [Security Considerations](https://docs.soliditylang.org/en/v0.8.26/security-considerations.html); the [OWASP Smart Contract Top 10 (2025)](https://owasp.org/www-project-smart-contract-top-10/); the [SWC Registry](https://swcregistry.io/), which says it has not been thoroughly updated since 2020; and OpenZeppelin's [Access Control](https://docs.openzeppelin.com/contracts/5.x/access-control) guide.

## SCSC (registration, reporting, certification)

| Test | Fault in the published source | Change in v2 | Guidance |
| --- | --- | --- | --- |
| S1 | A manufacturer can overwrite a pending registration, so the record the regulator approves may differ from the one it reviewed. | A pending registration cannot be overwritten. | OWASP SC03 Logic Errors |
| S2 | The regulator can approve an address that never registered, creating a registered manufacturer with no details. | Approval needs a pending registration. | OWASP SC04 Lack of Input Validation |
| S3 | There is no way to reject a registration. The paper says the regulator rejects non-compliant applicants. | `rejectRegistration` clears a pending request; the manufacturer may apply again. | Paper, regulator role |
| S4 | The name and location in the registration events are `indexed` strings, so the logs hold only their hashes, not the text. | The strings are no longer indexed. | Shown by test S4 |
| S5 | The reporting cycle scales the emission factor by 100, but the certificate uses an unscaled integer ratio, so any factor below 1 is recorded as 0 (999 / 1000 gives 99 on the cycle and 0 on the certificate). | Both use the same factor, scaled by `SCALE = 100`. | OWASP SC03 Logic Errors |
| S6, S7 | Issuing a certificate with no production, or with no reports since the last certificate, fails with a division-by-zero panic. | Both revert with a stated reason. | OWASP SC04 Lack of Input Validation |
| S8 | A certificate can be approved repeatedly. | It can be approved once. | OWASP SC03 Logic Errors |

The fixed `timeElapsed = 1` is removed. The cycle event now states plainly that it reports the cycle's totals; its field names are unchanged, so tools that read the event still work. The pragma is fixed at `0.8.26` (SWC-103 Floating Pragma). The unused `approved` modifier and the out-of-date comments are removed.

## AuditSC (auditing)

| Test | Fault in the published source | Change in v2 | Guidance |
| --- | --- | --- | --- |
| A1 | Any account that is not the regulator, or the manufacturer of the newest request, counts as an auditor. The paper says only registered auditors may apply. | The regulator registers auditors (`setAuditor`), and only registered auditors may apply and submit. | OWASP SC01 Access Control; OpenZeppelin Access Control |
| A2 | Before any request exists, the auditor check underflows and panics. | Every request ID is checked first, with a stated reason. | OWASP SC04 |
| A3 | The auditor check compares the caller with the manufacturer of the newest request, not the request being acted on. An accepted auditor can be locked out when a later request names it. | The check uses the request's own manufacturer. | OWASP SC03 |
| A4 | An auditor can apply for the same request many times. With an open auditor role, this also lets anyone grow the list that `acceptAuditor` loops over until the call costs more gas than a block allows. | One application per auditor. Acceptance no longer loops over applicants. | Solidity documentation, Gas Limit and Loops; SWC-128; OWASP SC10 |
| A5 | Accepting an account that did not apply closes the request with no auditor, so the audit can never finish. | Acceptance needs an application from a registered auditor. | OWASP SC03 |
| A6 | The accepted auditor can replace the report and its pass or fail result at any time, even after the regulator approved it. | A report is submitted once. It can be resubmitted only after the regulator rejects it. | OWASP SC01, SC03 |
| A7 | The regulator cannot reject a report that says "passed": the check meant to stop approval of a failed audit is inverted. | The regulator can approve or reject any submitted report. A rejection is recorded and reopens submission, as the paper describes. | OWASP SC03 |
| A8, A9 | Rejecting a report still sets `isApproved` to true, so the regulator's decision is not stored. `AuditCompleted` always reports `passed = true`. | `isApproved` records the regulator's approval. `AuditCompleted` carries the auditor's result, and `isCompliant` is true only for an approved passing audit. | OWASP SC03 |
| A10 | An audit can be requested for the zero address. | Rejected. | OWASP SC04 |

`requestAudit` now builds the request in storage, so the uninitialised local array that Slither flagged in the paper's security analysis is no longer there. The unused `isOpen` and `notCompleted` modifiers are removed, and the accepted auditor is held in one field rather than a one-item array.

## Not changed: design questions for the next version

These are gaps between the paper's description and the code that need a design decision rather than a bug fix:

- `issueCertificate` does not check that an audit has been approved, and no score threshold decides whether a certificate is issued. The paper describes both.
- `connectSensors` is a flag the manufacturer sets itself, and reported values are self-declared. The paper describes oracle-fed monitoring data.
- The violation threshold is fixed at 1000 for every manufacturer, with no way for the regulator to set it, and it is compared with each report's absolute emissions rather than an intensity.
- There is no revocation of a registration or a certificate, and the regulator address cannot be changed, so a lost regulator key stops both contracts.
- Everything stored on a public chain, including names, locations and report identifiers, is readable by anyone. The `private` keyword limits other contracts, not readers (Solidity documentation, Private Information and Randomness).
