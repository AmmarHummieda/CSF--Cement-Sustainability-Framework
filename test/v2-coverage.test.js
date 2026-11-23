// Coverage tests for CSF_v2.sol only (see docs/v2-changes.md):
// - new capabilities and terms that the published source does not have (S3, A11);
// - regression tests that guard v2 behaviour the fault tests do not reach.
// Unlike test/v2-fixes.test.js, these are not run against the published baseline:
// some would pass there, and others would fail only because a function is missing.
const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { createChain, deploy, expectRevert, parsedEvents } = require("./helpers");

const SOURCE = "CSF_v2.sol";
const ONLY_REGULATOR = /Only regulator/;

const chains = [];
afterEach(async () => Promise.all(chains.splice(0).map(({ connection }) => connection.close())));

async function scscChain() {
  const chain = await createChain();
  chains.push(chain);
  const [regulator, manufacturer, auditor, outsider] = chain.signers;
  const scsc = await deploy("SCSC", regulator, SOURCE);
  return { regulator, manufacturer, outsider, scsc, address: await manufacturer.getAddress() };
}

async function connectedManufacturer() {
  const setup = await scscChain();
  const { regulator, manufacturer, scsc, address } = setup;
  await (await scsc.connect(manufacturer).register("Cement One", "Abu Dhabi", "ipfs://registration")).wait();
  await (await scsc.connect(regulator).approveRegistration(address)).wait();
  await (await scsc.connect(manufacturer).connectSensors()).wait();
  return setup;
}

async function report(scsc, manufacturer, emissions, production) {
  await (await scsc.connect(manufacturer).reportEmissions(emissions, production, "ipfs://report")).wait();
}

async function auditChain() {
  const chain = await createChain();
  chains.push(chain);
  const [regulator, manufacturer, auditor, outsider, secondAuditor] = chain.signers;
  const audit = await deploy("AuditSC", regulator, SOURCE);
  for (const account of [auditor, secondAuditor]) {
    await (await audit.connect(regulator).setRegisteredAuditor(await account.getAddress(), true)).wait();
  }
  return { regulator, manufacturer, auditor, outsider, secondAuditor, audit };
}

async function acceptedAudit() {
  const setup = await auditChain();
  const { regulator, manufacturer, auditor, audit } = setup;
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await (await audit.connect(auditor).applyForAudit(0)).wait();
  await (await audit.connect(regulator).acceptAuditor(0, await auditor.getAddress())).wait();
  return setup;
}

// --- New capabilities and terms ------------------------------------------

test("capability S3: the regulator can reject a pending registration, and the manufacturer can then register again", async () => {
  const { regulator, manufacturer, scsc, address } = await scscChain();
  await (await scsc.connect(manufacturer).register("First", "A", "ipfs://first")).wait();
  await (await scsc.connect(regulator).rejectRegistration(address)).wait();
  assert.equal((await scsc.manufacturers(address)).manufacturerAddress, "0x0000000000000000000000000000000000000000");
  await (await scsc.connect(manufacturer).register("Corrected", "A", "ipfs://corrected")).wait();
  assert.equal((await scsc.manufacturers(address)).name, "Corrected");
});

test("terms A11: a registered auditor that is not the accepted auditor cannot submit the request's report", async () => {
  const { regulator, manufacturer, auditor, secondAuditor, audit } = await auditChain();
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await (await audit.connect(auditor).applyForAudit(0)).wait();
  await (await audit.connect(secondAuditor).applyForAudit(0)).wait();
  await (await audit.connect(regulator).acceptAuditor(0, await auditor.getAddress())).wait();
  await expectRevert(() => audit.connect(secondAuditor).submitAuditReport(0, "ipfs://not-mine", true), /Only accepted auditor/i);
});

// --- Reporting cycles and the certificate -------------------------------

test("v2 flow: the 1200 / 300 example gives a scaled factor of 400 on the cycle, the certificate and its event", async () => {
  const { regulator, manufacturer, scsc, address } = await connectedManufacturer();
  await report(scsc, manufacturer, 1200, 300);
  let receipt = await (await scsc.connect(regulator).calculateAverageAndEmissionFactor(address)).wait();
  const cycle = parsedEvents(scsc, receipt, "ReportingCycleCompleted")[0];
  assert.deepEqual([cycle.args.emissionsPerYear, cycle.args.tonsOfCementProducedPerYear, cycle.args.emissionFactor], [1200n, 300n, 400n]);
  receipt = await (await scsc.connect(regulator).issueCertificate(address)).wait();
  assert.equal(parsedEvents(scsc, receipt, "CertificateIssued")[0].args.sustainabilityScore, 400n);
  await (await scsc.connect(regulator).approveCertificate(0)).wait();
  const certificate = await scsc.certifications(0);
  assert.deepEqual([certificate.emissionFactor, certificate.sustainabilityScore, certificate.regulatorApproved], [400n, 400n, true]);
  const state = await scsc.manufacturers(address);
  assert.deepEqual([state.totalEmissions, state.tonsOfCementProduced, state.numReports], [0n, 0n, 0n]);
});

test("regression: two unequal reports in one cycle are summed before the factor is taken", async () => {
  const { regulator, manufacturer, scsc, address } = await connectedManufacturer();
  await report(scsc, manufacturer, 1000, 200); // factor 500 on its own
  await report(scsc, manufacturer, 500, 300); // factor 166 on its own
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  const certificate = await scsc.certifications(0);
  // (1000 + 500) * 100 / (200 + 300) = 300. Keeping only the last report would give 166,
  // and averaging the two reports' factors would give 333.
  assert.deepEqual(
    [certificate.emissionsPerYear, certificate.tonsOfCementProducedPerYear, certificate.emissionFactor],
    [1500n, 500n, 300n]
  );
});

test("regression: a second cycle uses only its own reports", async () => {
  const { regulator, manufacturer, scsc, address } = await connectedManufacturer();
  await report(scsc, manufacturer, 1200, 300);
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  await report(scsc, manufacturer, 300, 100);
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  const second = await scsc.certifications(1);
  assert.deepEqual([second.emissionsPerYear, second.tonsOfCementProducedPerYear, second.emissionFactor], [300n, 100n, 300n]);
});

// --- Audits --------------------------------------------------------------

test("regression: the accepted auditor cannot submit once the regulator removes its registration", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(regulator).setRegisteredAuditor(await auditor.getAddress(), false)).wait();
  await expectRevert(() => audit.connect(auditor).submitAuditReport(0, "ipfs://report", true), /registered auditors/i);
});

test("regression: after a failed report is rejected, the accepted auditor can resubmit", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://failed", false)).wait();
  const receipt = await (await audit.connect(regulator).rejectAuditReport(0)).wait();
  assert.equal(parsedEvents(audit, receipt, "AuditReportRejected").length, 1);
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://revised", true)).wait();
  await (await audit.connect(regulator).acceptAuditReport(0)).wait();
  assert.equal(await audit.isAuditApproved(0), true);
});

test("regression: a passing report is not an approved audit until the regulator accepts it", async () => {
  const { auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://passed", true)).wait();
  assert.equal(await audit.isAuditApproved(0), false);
});

for (const passed of [true, false]) {
  test(`regression: accepting a ${passed ? "passing" : "failed"} report announces its result and allows no second decision`, async () => {
    const { regulator, auditor, audit } = await acceptedAudit();
    await (await audit.connect(auditor).submitAuditReport(0, "ipfs://report", passed)).wait();
    const receipt = await (await audit.connect(regulator).acceptAuditReport(0)).wait();
    assert.equal(parsedEvents(audit, receipt, "AuditReportAccepted")[0].args.passed, passed);
    assert.equal(parsedEvents(audit, receipt, "AuditCompleted")[0].args.passed, passed);
    await expectRevert(() => audit.connect(regulator).acceptAuditReport(0), /already accepted/i);
    await expectRevert(() => audit.connect(regulator).rejectAuditReport(0), /already accepted/i);
    assert.equal(await audit.isAuditApproved(0), passed);
  });
}

// --- Access control ------------------------------------------------------

test("regression: an outsider cannot call any regulator-only function of SCSC", async () => {
  const { regulator, manufacturer, outsider, scsc, address } = await connectedManufacturer();
  await report(scsc, manufacturer, 1200, 300);
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  await report(scsc, manufacturer, 1200, 300);
  const asOutsider = scsc.connect(outsider);
  await expectRevert(() => asOutsider.approveRegistration(address), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.rejectRegistration(address), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.calculateAverageAndEmissionFactor(address), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.issueCertificate(address), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.approveCertificate(0), ONLY_REGULATOR);
});

test("regression: an outsider cannot call any regulator-only function of AuditSC", async () => {
  const { auditor, outsider, manufacturer, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://report", true)).wait();
  const asOutsider = audit.connect(outsider);
  await expectRevert(async () => asOutsider.setRegisteredAuditor(await outsider.getAddress(), true), ONLY_REGULATOR);
  await expectRevert(async () => asOutsider.requestAudit(await manufacturer.getAddress()), ONLY_REGULATOR);
  await expectRevert(async () => asOutsider.acceptAuditor(0, await auditor.getAddress()), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.acceptAuditReport(0), ONLY_REGULATOR);
  await expectRevert(() => asOutsider.rejectAuditReport(0), ONLY_REGULATOR);
});
