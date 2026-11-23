// Tests for the corrections in CSF_v2.sol (see docs/v2-changes.md).
// They pass against CSF_v2.sol (the default) and are expected to fail against the
// published baseline, which shows each fault is real:
//   CSF_SOURCE=CSF_vLatest.sol node --test test/v2-fixes.test.js
const assert = require("node:assert/strict");
const { afterEach, test } = require("node:test");
const { createChain, deploy, expectRevert, parsedEvents } = require("./helpers");

const SOURCE = process.env.CSF_SOURCE || "CSF_v2.sol";

const chains = [];
afterEach(async () => Promise.all(chains.splice(0).map(({ connection }) => connection.close())));

function hasFunction(contract, name) {
  return contract.interface.fragments.some((fragment) => fragment.type === "function" && fragment.name === name);
}

async function scscChain() {
  const chain = await createChain();
  chains.push(chain);
  const [regulator, manufacturer, auditor, outsider] = chain.signers;
  const scsc = await deploy("SCSC", regulator, SOURCE);
  return { regulator, manufacturer, auditor, outsider, scsc, address: await manufacturer.getAddress() };
}

async function reportingManufacturer({ emissions, production }) {
  const setup = await scscChain();
  const { regulator, manufacturer, scsc, address } = setup;
  await (await scsc.connect(manufacturer).register("Cement One", "Abu Dhabi", "ipfs://registration")).wait();
  await (await scsc.connect(regulator).approveRegistration(address)).wait();
  await (await scsc.connect(manufacturer).connectSensors()).wait();
  await (await scsc.connect(manufacturer).reportEmissions(emissions, production, "ipfs://report")).wait();
  return setup;
}

// Terms (the paper, SASBE 2025, pp. 18-21): a registered auditor may apply; the
// accepted auditor is the one selected for a request; the regulator accepts or
// rejects a submitted report; an approved audit is an accepted report that passed.
// The adapters below map these to the baseline's single approveAuditResult(id, bool),
// so on the baseline each test fails on the fault itself, not on a missing name.
async function acceptReport(audit, regulator, id) {
  if (hasFunction(audit, "acceptAuditReport")) return (await audit.connect(regulator).acceptAuditReport(id)).wait();
  return (await audit.connect(regulator).approveAuditResult(id, true)).wait();
}

async function rejectReport(audit, regulator, id) {
  if (hasFunction(audit, "rejectAuditReport")) return (await audit.connect(regulator).rejectAuditReport(id)).wait();
  return (await audit.connect(regulator).approveAuditResult(id, false)).wait();
}

function isAccepted(state) {
  return "isAccepted" in state.toObject() ? state.isAccepted : state.isApproved;
}

async function isAuditApproved(audit, id) {
  if (hasFunction(audit, "isAuditApproved")) return audit.isAuditApproved(id);
  const state = await audit.auditRequests(id);
  return state.isApproved && state.passed;
}

// Registers the auditors where the contract has an auditor registry (CSF_v2).
// The baseline has none, so the same tests then exercise its open auditor role.
async function auditChain({ register = true } = {}) {
  const chain = await createChain();
  chains.push(chain);
  const [regulator, manufacturer, auditor, outsider, secondAuditor] = chain.signers;
  const audit = await deploy("AuditSC", regulator, SOURCE);
  if (register && hasFunction(audit, "setRegisteredAuditor")) {
    for (const account of [auditor, secondAuditor]) {
      await (await audit.connect(regulator).setRegisteredAuditor(await account.getAddress(), true)).wait();
    }
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

// --- SCSC ---------------------------------------------------------------

test("fix S1: a pending registration cannot be overwritten before the regulator decides", async () => {
  const { manufacturer, scsc } = await scscChain();
  await (await scsc.connect(manufacturer).register("First", "A", "ipfs://first")).wait();
  await expectRevert(() => scsc.connect(manufacturer).register("Second", "B", "ipfs://second"), /already pending/i);
});

test("fix S2: the regulator cannot approve an address that never registered", async () => {
  const { regulator, outsider, scsc } = await scscChain();
  await expectRevert(async () => scsc.connect(regulator).approveRegistration(await outsider.getAddress()), /No pending registration/i);
});

test("fix S3: the regulator can reject a pending registration, and the manufacturer can then register again", async () => {
  const { regulator, manufacturer, scsc, address } = await scscChain();
  await (await scsc.connect(manufacturer).register("First", "A", "ipfs://first")).wait();
  await (await scsc.connect(regulator).rejectRegistration(address)).wait();
  assert.equal((await scsc.manufacturers(address)).manufacturerAddress, "0x0000000000000000000000000000000000000000");
  await (await scsc.connect(manufacturer).register("Corrected", "A", "ipfs://corrected")).wait();
  assert.equal((await scsc.manufacturers(address)).name, "Corrected");
});

test("fix S4: registration events carry the name and location as readable text", async () => {
  const { regulator, manufacturer, scsc, address } = await scscChain();
  let receipt = await (await scsc.connect(manufacturer).register("Cement One", "Abu Dhabi", "ipfs://registration")).wait();
  const requested = parsedEvents(scsc, receipt, "RegistrationRequested")[0];
  assert.deepEqual([requested.args.name, requested.args.location], ["Cement One", "Abu Dhabi"]);
  receipt = await (await scsc.connect(regulator).approveRegistration(address)).wait();
  assert.equal(parsedEvents(scsc, receipt, "RegistrationApproved")[0].args.name, "Cement One");
});

test("fix S5: the certificate keeps the same scaled emission factor as the reporting cycle", async () => {
  const { regulator, scsc, address } = await reportingManufacturer({ emissions: 999, production: 1000 });
  const receipt = await (await scsc.connect(regulator).calculateAverageAndEmissionFactor(address)).wait();
  assert.equal(parsedEvents(scsc, receipt, "ReportingCycleCompleted")[0].args.emissionFactor, 99n);
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  const certificate = await scsc.certifications(0);
  assert.deepEqual([certificate.emissionFactor, certificate.sustainabilityScore], [99n, 99n]);
});

test("fix S6: issuing a certificate with no production reported reverts with a reason, not a division panic", async () => {
  const { regulator, scsc, address } = await reportingManufacturer({ emissions: 400, production: 0 });
  await expectRevert(() => scsc.connect(regulator).issueCertificate(address), /No production reported/);
});

test("fix S7: issuing a second certificate with no new reports reverts with a reason", async () => {
  const { regulator, scsc, address } = await reportingManufacturer({ emissions: 400, production: 100 });
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  await expectRevert(() => scsc.connect(regulator).issueCertificate(address), /No reports available/);
});

test("fix S8: a certificate can be approved only once", async () => {
  const { regulator, scsc, address } = await reportingManufacturer({ emissions: 400, production: 100 });
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  await (await scsc.connect(regulator).approveCertificate(0)).wait();
  await expectRevert(() => scsc.connect(regulator).approveCertificate(0), /already approved/i);
});

test("v2 flow: the 1200 / 300 example gives a scaled factor of 400 on both the cycle and the certificate", async () => {
  const { regulator, scsc, address } = await reportingManufacturer({ emissions: 1200, production: 300 });
  const receipt = await (await scsc.connect(regulator).calculateAverageAndEmissionFactor(address)).wait();
  const cycle = parsedEvents(scsc, receipt, "ReportingCycleCompleted")[0];
  assert.deepEqual([cycle.args.emissionsPerYear, cycle.args.tonsOfCementProducedPerYear, cycle.args.emissionFactor], [1200n, 300n, 400n]);
  await (await scsc.connect(regulator).issueCertificate(address)).wait();
  await (await scsc.connect(regulator).approveCertificate(0)).wait();
  const certificate = await scsc.certifications(0);
  assert.deepEqual([certificate.emissionFactor, certificate.sustainabilityScore, certificate.regulatorApproved], [400n, 400n, true]);
  const state = await scsc.manufacturers(address);
  assert.deepEqual([state.totalEmissions, state.tonsOfCementProduced, state.numReports], [0n, 0n, 0n]);
});

// --- AuditSC ------------------------------------------------------------

test("fix A1: an account the regulator has not registered as an auditor cannot apply", async () => {
  const { regulator, manufacturer, outsider, audit } = await auditChain();
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await expectRevert(() => audit.connect(outsider).applyForAudit(0), /registered auditors/i);
});

test("fix A2: applying for a request that does not exist reverts with a reason, not a panic", async () => {
  const { auditor, audit } = await auditChain();
  await expectRevert(() => audit.connect(auditor).applyForAudit(0), /does not exist/i);
});

test("fix A3: the auditor check uses the request's own manufacturer, not the latest request's", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(regulator).requestAudit(await auditor.getAddress())).wait();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://report", true)).wait();
  assert.equal((await audit.auditRequests(0)).isCompleted, true);
});

test("fix A4: an auditor can apply for a request only once", async () => {
  const { regulator, manufacturer, auditor, audit } = await auditChain();
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await (await audit.connect(auditor).applyForAudit(0)).wait();
  await expectRevert(() => audit.connect(auditor).applyForAudit(0), /already applied/i);
});

test("fix A5: accepting an account that did not apply reverts and leaves the request open", async () => {
  const { regulator, manufacturer, auditor, secondAuditor, audit } = await auditChain();
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await (await audit.connect(auditor).applyForAudit(0)).wait();
  await expectRevert(async () => audit.connect(regulator).acceptAuditor(0, await secondAuditor.getAddress()), /did not apply/i);
  assert.equal((await audit.auditRequests(0)).isOpen, true);
});

test("fix A6: a submitted report cannot be overwritten, before or after the regulator's approval", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://first", true)).wait();
  await expectRevert(() => audit.connect(auditor).submitAuditReport(0, "ipfs://second", false), /already submitted/i);
  await acceptReport(audit, regulator, 0);
  await expectRevert(() => audit.connect(auditor).submitAuditReport(0, "ipfs://replacement", false), /already submitted/i);
  const state = await audit.auditRequests(0);
  assert.deepEqual([state.reportIPFSHash, state.passed], ["ipfs://first", true]);
});

test("fix A7: the regulator can reject a passing report; the rejection is recorded and reopens submission", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://inadequate", true)).wait();
  await rejectReport(audit, regulator, 0);
  let state = await audit.auditRequests(0);
  assert.deepEqual([isAccepted(state), state.isCompleted], [false, false]);
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://revised", true)).wait();
  await acceptReport(audit, regulator, 0);
  state = await audit.auditRequests(0);
  assert.deepEqual([state.reportIPFSHash, isAccepted(state), state.passed], ["ipfs://revised", true, true]);
  assert.equal(await isAuditApproved(audit, 0), true);
});

test("fix A8: rejecting a failed report does not mark it accepted", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://failed", false)).wait();
  await rejectReport(audit, regulator, 0);
  assert.equal(isAccepted(await audit.auditRequests(0)), false);
});

test("fix A9: accepting a failed report makes it final, and it is not an approved audit", async () => {
  const { regulator, auditor, audit } = await acceptedAudit();
  await (await audit.connect(auditor).submitAuditReport(0, "ipfs://failed", false)).wait();
  const receipt = await acceptReport(audit, regulator, 0);
  assert.equal(parsedEvents(audit, receipt, "AuditCompleted")[0].args.passed, false);
  assert.equal(isAccepted(await audit.auditRequests(0)), true);
  assert.equal(await isAuditApproved(audit, 0), false);
});

test("terms A11: a registered auditor that is not the accepted auditor cannot submit the request's report", async () => {
  const { regulator, manufacturer, auditor, secondAuditor, audit } = await auditChain();
  await (await audit.connect(regulator).requestAudit(await manufacturer.getAddress())).wait();
  await (await audit.connect(auditor).applyForAudit(0)).wait();
  await (await audit.connect(secondAuditor).applyForAudit(0)).wait();
  await (await audit.connect(regulator).acceptAuditor(0, await auditor.getAddress())).wait();
  await expectRevert(() => audit.connect(secondAuditor).submitAuditReport(0, "ipfs://not-mine", true), /Only accepted auditor/i);
  await (await audit.connect(regulator).setRegisteredAuditor(await secondAuditor.getAddress(), false)).wait();
  assert.equal(await audit.isRegisteredAuditor(await secondAuditor.getAddress()), false);
});

test("fix A10: an audit cannot be requested for the zero address", async () => {
  const { regulator, audit } = await auditChain();
  await expectRevert(() => audit.connect(regulator).requestAudit("0x0000000000000000000000000000000000000000"), /Invalid manufacturer/i);
});
