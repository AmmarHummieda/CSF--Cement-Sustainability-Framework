// Runs test/v2-fixes.test.js against the published baseline, CSF_vLatest.sol.
// Every test is expected to FAIL there: that shows each corrected fault is present
// in the baseline. Exits 0 only when all of them fail.
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", "--test-reporter=tap", path.join("test", "v2-fixes.test.js")],
  {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CSF_SOURCE: "CSF_vLatest.sol" },
    encoding: "utf8",
    windowsHide: true
  }
);

const output = `${result.stdout || ""}`;
const count = (label) => Number((output.match(new RegExp(`^# ${label} (\\d+)`, "m")) || [])[1] || NaN);
const tests = count("tests");
const failed = count("fail");
const passedNames = output.split(/\r?\n/).filter((line) => /^ok \d+ /.test(line));

console.log(`Baseline CSF_vLatest.sol: ${failed} of ${tests} v2 fix tests fail (expected: all).`);
if (!Number.isFinite(tests) || tests === 0 || failed !== tests) {
  if (passedNames.length > 0) console.log(`Unexpectedly passing on the baseline:\n${passedNames.join("\n")}`);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = 1;
}
