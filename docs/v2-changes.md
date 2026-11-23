# CSF_v2: corrections to the published contracts

`CSF_vLatest.sol` is the source published with the [article](https://doi.org/10.1108/SASBE-08-2024-0291). It stays byte-identical, so the paper's results remain reproducible and the source-integrity check still holds. `CSF_v2.sol` is a corrected copy. It keeps the same two contracts, roles and four-stage workflow. It fixes faults found in a review of the published source on 23 November 2026, and two more found by an independent review of v2 the same day.

## How the changes are checked

There are three kinds of change, and they are checked differently:

- **Behavioural fixes** (S1, S2, S4–S10, A1–A10 below): each has a fault test in `test/v2-fixes.test.js`. The test passes against `CSF_v2.sol`. `npm run test:baseline-faults` runs the same tests against `CSF_vLatest.sol`, where each one fails on the fault it names (an unexpected success, a panic or a wrong value), not on a missing function.
- **New capabilities and terms** (S3 `rejectRegistration`; A11, the accepted-auditor rule in the paper's terms): tested in `test/v2-coverage.test.js` against v2 only. The published source has no such function, so a run against it would show only that the function is missing.
- **Regression tests** in `test/v2-coverage.test.js` guard v2 behaviour that the fault tests do not reach: cycle totals over two reports, a second cycle, a de-registered accepted auditor, resubmission after a failed report is rejected, approval before acceptance, no second decision after acceptance on both results, and outsiders calling every regulator-only function.

Where a claim below is marked *(inspection)*, it was checked by reading the code, not by a test.

Sources for the security checks: the Solidity 0.8.26 documentation, [Security Considerations](https://docs.soliditylang.org/en/v0.8.26/security-considerations.html); the [OWASP Smart Contract Top 10 (2025)](https://owasp.org/www-project-smart-contract-top-10/); the [SWC Registry](https://swcregistry.io/), which says it has not been thoroughly updated since 2020; and OpenZeppelin's [Access Control](https://docs.openzeppelin.com/contracts/5.x/access-control) guide.

## SCSC (registration, reporting, certification)

| Test | Fault in the published source | Change in v2 | Guidance |
| --- | --- | --- | --- |
| S1 | A manufacturer can overwrite a pending registration, so the record the regulator approves may differ from the one it reviewed. | A pending registration cannot be overwritten. | OWASP SC03 Logic Errors |
| S2 | The regulator can approve an address that never registered, creating a registered manufacturer with no details. | Approval needs a pending registration. | OWASP SC04 Lack of Input Validation |
| S3 (capability) | There is no way to reject a registration. The paper says the regulator rejects non-compliant applicants. | `rejectRegistration` clears a pending request; the manufacturer may apply again. | Paper, regulator role |
| S4 | The name and location in the registration events are `indexed` strings, so the logs hold only their hashes, not the text. | The strings are no longer indexed; the test reads both from both events. | Shown by test S4 |
| S5 | The reporting cycle scales the emission factor by 100, but the certificate uses an unscaled integer ratio, so any factor below 1 is recorded as 0 (999 / 1000 gives 99 on the cycle and 0 on the certificate). | Both use the same factor, scaled by `SCALE = 100`. | OWASP SC03 Logic Errors |
| S6, S7 | Issuing a certificate with no production, or with no reports since the last certificate, fails with a division-by-zero panic. | Both revert with a stated reason. | OWASP SC04 Lack of Input Validation |
| S8 | A certificate can be approved repeatedly. | It can be approved once. | OWASP SC03 Logic Errors |
| S9 | Calculating a cycle with no production announces an emission factor of 0, which reads as a very low emission intensity, while issuing a certificate from the same totals is refused. | Calculation validates exactly as issuance does: it reverts with "No production reported". | OWASP SC03 Logic Errors |
| S10 | Reports are accepted until `totalEmissions * 100` no longer fits in a `uint256`; from then on neither calculation nor issuance can run, and issuance is the only way to reset the cycle. It needs unrealistically large numbers. | A report that would take the cycle's emissions above `type(uint256).max / SCALE` is rejected. | OWASP SC04 Lack of Input Validation |

**Values are in hundredths.** Solidity has no decimal numbers, so v2 stores the emission factor (total emissions divided by production) multiplied by `SCALE = 100`, everywhere it appears: the `emissionFactor` in the reporting-cycle event, the `emissionFactor` and `sustainabilityScore` on the certificate, and the score in `CertificateIssued`. A stored 400 means 4.00, and 99 means 0.99. Division rounds down, so the error is under 0.01. The published source used this scale on the reporting cycle only.

*(inspection)* The fixed `timeElapsed = 1` is removed. The cycle event now states plainly that it reports the cycle's totals; its field names (`emissionsPerYear`, `tonsOfCementProducedPerYear`) are unchanged, so tools that read the event still work. The pragma is fixed at `0.8.26` (SWC-103 Floating Pragma). The unused `approved` modifier and the out-of-date comments are removed.

## AuditSC (auditing)

| Test | Fault in the published source | Change in v2 | Guidance |
| --- | --- | --- | --- |
| A1 | Any account that is not the regulator, or the manufacturer of the newest request, counts as an auditor. The paper says only registered auditors may apply. | The regulator registers auditors (`setRegisteredAuditor`), and only registered auditors may apply and submit. | OWASP SC01 Access Control; OpenZeppelin Access Control |
| A2 | Before any request exists, the auditor check underflows and panics. | Every request ID is checked first, with a stated reason. Tested on `applyForAudit`; the same `requestExists` check on the other functions *(inspection)*. | OWASP SC04 |
| A3 | The auditor check compares the caller with the manufacturer of the newest request, not the request being acted on. An accepted auditor can be locked out when a later request names it. | The check uses the request's own manufacturer. Tested: the lock-out is gone. That a manufacturer cannot apply for its own request *(inspection)*. | OWASP SC03 |
| A4 | An auditor can apply for the same request many times. With an open auditor role, this also lets anyone grow the list that `acceptAuditor` loops over until the call costs more gas than a block allows. | One application per auditor (tested). Acceptance no longer loops over applicants *(inspection)*. | Solidity documentation, Gas Limit and Loops; SWC-128; OWASP SC10 |
| A5 | Accepting an account that did not apply closes the request with no auditor, so the audit can never finish. | Acceptance needs an application (tested) from an auditor that is still registered *(inspection)*. | OWASP SC03 |
| A6 | The accepted auditor can replace the report and its pass or fail result at any time, even after the regulator approved it. | A report is submitted once. It can be resubmitted only after the regulator rejects it. | OWASP SC01, SC03 |
| A7 | The regulator cannot reject a report that says "passed": the check meant to stop approval of a failed audit is inverted. | The regulator accepts (`acceptAuditReport`) or rejects (`rejectAuditReport`) any submitted report. A rejection reopens submission, as the paper describes. | OWASP SC03 |
| A8, A9 | Rejecting a report still sets `isApproved` to true, so the regulator's decision is not stored. `AuditCompleted` always reports `passed = true`. | `isAccepted` records the regulator's acceptance. `AuditCompleted` carries the auditor's result. `isAuditApproved` is true only for an accepted report that passed. | OWASP SC03 |
| A10 | An audit can be requested for the zero address. | Rejected. | OWASP SC04 |
| A11 (terms) | — | Only the accepted auditor can submit a request's report; another registered auditor cannot. | Paper, p. 19 |

*(inspection)* `requestAudit` now builds the request in storage, so the uninitialised local array that Slither flagged in the paper's security analysis is no longer there. The unused `isOpen` and `notCompleted` modifiers are removed, and the accepted auditor is held in one field rather than a one-item array.

## Terms

The code uses the paper's terms, so that each word means one thing:

- **Registered auditor**: an account the regulator has authorised to take part in audits (`setRegisteredAuditor`, `isRegisteredAuditor`). The paper: "Only registered auditors are eligible to apply" (SASBE 2025, p. 21).
- **Accepted auditor**: the registered auditor the regulator selects for one request (`acceptAuditor`, `acceptedAuditor`). Only it can submit that request's report (p. 19). One figure caption calls it "approved to conduct" the audit (p. 23).
- **Accepting or rejecting a report**: the regulator's review of a submitted report (`acceptAuditReport`, `rejectAuditReport`). The paper: "approve the satisfactory results or reject them if deemed inadequate" (p. 19).
- **Approved audit**: an accepted report that passed (`isAuditApproved`). The paper: "Approval signifies compliance with regulatory standards" (p. 19).

The published source used one function, `approveAuditResult(id, approved)`, for both acceptance and rejection, and one flag, `isApproved`, that was set either way.

## Not changed: design questions for the next version

These are gaps between the paper's description and the code that need a design decision rather than a bug fix:

- **The sustainability score is fixed and equals the emission factor.** The paper says the manufacturer prompts the contract "to compute the sustainability score - the algorithm for which can be set by the regulator", and that "if the score is above the certification threshold, a certificate is issued" (SASBE 2025, p. 15). In the code, published and v2, the score is the scaled emission factor itself. No function lets the regulator set the scoring algorithm, and there is no certification threshold, so a higher score means more emissions per tonne. The direction of the score and the threshold are open; the score design belongs to the next version.
- `issueCertificate` does not check that an audit has been approved. The paper describes this.
- Calculation is optional and repeatable, and reports can still arrive between calculation and issuance. The certificate uses the totals at issuance, not a frozen copy of the announced cycle.
- If the regulator removes the accepted auditor's registration, that request cannot be completed; the regulator must restore the registration or open a new request.
- `connectSensors` is a flag the manufacturer sets itself, and reported values are self-declared. The paper describes oracle-fed monitoring data.
- The violation threshold is fixed at 1000 for every manufacturer, with no way for the regulator to set it, and it is compared with each report's absolute emissions rather than an intensity.
- There is no revocation of a registration or a certificate, and the regulator address cannot be changed, so a lost regulator key stops both contracts.
- Everything stored on a public chain, including names, locations and report identifiers, is readable by anyone. The `private` keyword limits other contracts, not readers (Solidity documentation, Private Information and Randomness).
