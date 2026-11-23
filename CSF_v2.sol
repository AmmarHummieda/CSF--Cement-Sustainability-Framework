// CSF_v2: corrected version of CSF_vLatest.sol.
// CSF_vLatest.sol stays byte-identical as the published research baseline
// (SASBE 2025, https://doi.org/10.1108/SASBE-08-2024-0291). Each change here is
// listed in docs/v2-changes.md, which says which test covers it, or that it was
// checked by inspection.

// SPDX-License-Identifier: MIT

pragma solidity 0.8.26;

contract SCSC {
    // Fixed-point scale for emission factors: values are in hundredths (400 means 4.00).
    uint256 public constant SCALE = 100;

    // Emission threshold set on registration approval (unchanged from the baseline).
    uint256 public constant DEFAULT_THRESHOLD = 1000;

    // Struct to hold manufacturer information
    struct Manufacturer {
        address manufacturerAddress;
        string name;
        string location;
        string registrationInfoIPFSHash;
        bool isRegistered;
        bool isConnectedToSensors;
        uint256 lastReportTimestamp;
        uint256 totalEmissions;
        uint256 numReports;
        uint256 threshold;
        uint256 tonsOfCementProduced;
    }

    // Struct to hold emissions report
    struct EmissionsReport {
        uint256 timestamp;
        uint256 emissions;
        string reportIPFSHash;
    }

    // Struct to hold certification information
    struct Certification {
        address manufacturerAddress;
        string name;
        string location;
        uint256 emissionsPerYear;
        uint256 tonsOfCementProducedPerYear;
        uint256 emissionFactor;
        uint256 sustainabilityScore;
        bool regulatorApproved;
    }

    // Address of the regulating authority
    address public immutable regulator;

    // Manufacturer records (public: all on-chain data is readable by anyone)
    mapping(address => Manufacturer) public manufacturers;

    // Emissions reports per manufacturer
    mapping(address => EmissionsReport[]) private emissionsReports;

    // Certificates
    Certification[] public certifications;

    // Strings are not indexed, so their text stays readable in the logs.
    event RegistrationRequested(address indexed manufacturerAddress, string name, string location);
    event RegistrationApproved(address indexed manufacturerAddress, string name, string location);
    event RegistrationRejected(address indexed manufacturerAddress);
    event SensorConnected(address indexed manufacturerAddress);
    event ViolationDetected(address indexed regulatorAddress, address indexed manufacturerAddress, uint256 indexed emissions);
    // Values are the totals of the current reporting cycle; emissionFactor is scaled by SCALE.
    event ReportingCycleCompleted(address indexed manufacturerAddress, uint256 emissionsPerYear, uint256 tonsOfCementProducedPerYear, uint256 emissionFactor);
    event CertificateIssued(
        address indexed manufacturerAddress,
        string name,
        string location,
        uint256 totalEmissions,
        uint256 tonsOfCementProduced,
        uint256 sustainabilityScore,
        bool isApproved
    );
    event CertificateIndex(uint256 indexed index);
    event CertificateApproved(uint256 indexed index);

    modifier onlyRegulator() {
        require(msg.sender == regulator, "Only regulator can perform this action");
        _;
    }

    modifier registered() {
        require(manufacturers[msg.sender].isRegistered, "Manufacturer is not registered");
        _;
    }

    modifier connectedToSensors() {
        require(manufacturers[msg.sender].isConnectedToSensors, "Manufacturer is not connected to sensors");
        _;
    }

    constructor() {
        regulator = msg.sender;
    }

    // Manufacturer requests registration. A pending request cannot be overwritten:
    // the regulator approves exactly what it reviewed (or rejects it).
    function register(string memory _name, string memory _location, string memory _registrationInfoIPFSHash) external {
        Manufacturer storage manufacturer = manufacturers[msg.sender];
        require(!manufacturer.isRegistered, "Manufacturer is already registered");
        require(manufacturer.manufacturerAddress == address(0), "Registration is already pending");
        manufacturers[msg.sender] = Manufacturer(msg.sender, _name, _location, _registrationInfoIPFSHash, false, false, 0, 0, 0, 0, 0);
        emit RegistrationRequested(msg.sender, _name, _location);
    }

    // Regulator approves a pending registration.
    function approveRegistration(address _manufacturerAddress) external onlyRegulator {
        Manufacturer storage manufacturer = manufacturers[_manufacturerAddress];
        require(!manufacturer.isRegistered, "Manufacturer is already approved and registered");
        require(manufacturer.manufacturerAddress == _manufacturerAddress && _manufacturerAddress != address(0), "No pending registration");
        manufacturer.isRegistered = true;
        manufacturer.threshold = DEFAULT_THRESHOLD;
        emit RegistrationApproved(manufacturer.manufacturerAddress, manufacturer.name, manufacturer.location);
    }

    // Regulator rejects a pending registration; the manufacturer may then register again.
    function rejectRegistration(address _manufacturerAddress) external onlyRegulator {
        Manufacturer storage manufacturer = manufacturers[_manufacturerAddress];
        require(!manufacturer.isRegistered, "Manufacturer is already approved and registered");
        require(manufacturer.manufacturerAddress == _manufacturerAddress && _manufacturerAddress != address(0), "No pending registration");
        delete manufacturers[_manufacturerAddress];
        emit RegistrationRejected(_manufacturerAddress);
    }

    // Manufacturer records its sensor connection status.
    function connectSensors() external registered {
        Manufacturer storage manufacturer = manufacturers[msg.sender];
        require(!manufacturer.isConnectedToSensors, "Sensors are already connected");
        manufacturer.isConnectedToSensors = true;
        emit SensorConnected(msg.sender);
    }

    // Manufacturer reports emissions and production for the current cycle.
    function reportEmissions(uint256 _emissions, uint256 _tonsOfCementProduced, string memory _reportIPFSHash) external registered connectedToSensors {
        Manufacturer storage manufacturer = manufacturers[msg.sender];
        emissionsReports[msg.sender].push(EmissionsReport(block.timestamp, _emissions, _reportIPFSHash));
        manufacturer.lastReportTimestamp = block.timestamp;
        manufacturer.totalEmissions += _emissions;
        // Keep the scaled factor computable: totalEmissions * SCALE must fit in uint256.
        require(manufacturer.totalEmissions <= type(uint256).max / SCALE, "Emissions total is too large");
        manufacturer.tonsOfCementProduced += _tonsOfCementProduced;
        manufacturer.numReports++;
        if (_emissions > manufacturer.threshold) {
            emit ViolationDetected(regulator, msg.sender, _emissions);
        }
    }

    // Emission factor of the current cycle, scaled by SCALE (emissions per unit of production).
    function _emissionFactor(Manufacturer storage manufacturer) private view returns (uint256) {
        require(manufacturer.numReports > 0, "No reports available");
        require(manufacturer.tonsOfCementProduced > 0, "No production reported");
        return (manufacturer.totalEmissions * SCALE) / manufacturer.tonsOfCementProduced;
    }

    // Regulator computes and announces the current cycle's totals and emission factor.
    // It validates exactly as issueCertificate does: no reports or no production reverts,
    // rather than announcing a factor of 0.
    function calculateAverageAndEmissionFactor(address _manufacturerAddress) external onlyRegulator {
        Manufacturer storage manufacturer = manufacturers[_manufacturerAddress];
        uint256 emissionFactor = _emissionFactor(manufacturer);
        emit ReportingCycleCompleted(_manufacturerAddress, manufacturer.totalEmissions, manufacturer.tonsOfCementProduced, emissionFactor);
    }

    // Regulator issues a certificate from the current cycle, then resets the cycle.
    // The certificate records the same scaled emission factor as the reporting cycle.
    function issueCertificate(address _manufacturerAddress) external onlyRegulator {
        Manufacturer storage manufacturer = manufacturers[_manufacturerAddress];
        require(manufacturer.isRegistered, "Manufacturer is not registered");
        uint256 emissionFactor = _emissionFactor(manufacturer);

        certifications.push(Certification({
            manufacturerAddress: _manufacturerAddress,
            name: manufacturer.name,
            location: manufacturer.location,
            emissionsPerYear: manufacturer.totalEmissions,
            tonsOfCementProducedPerYear: manufacturer.tonsOfCementProduced,
            emissionFactor: emissionFactor,
            sustainabilityScore: emissionFactor,
            regulatorApproved: false
        }));

        emit CertificateIssued(
            _manufacturerAddress,
            manufacturer.name,
            manufacturer.location,
            manufacturer.totalEmissions,
            manufacturer.tonsOfCementProduced,
            emissionFactor,
            false
        );
        emit CertificateIndex(certifications.length - 1);

        manufacturer.totalEmissions = 0;
        manufacturer.numReports = 0;
        manufacturer.tonsOfCementProduced = 0;
    }

    // Regulator approves a certificate once.
    function approveCertificate(uint256 _index) external onlyRegulator {
        require(_index < certifications.length, "Certificate index out of bounds");
        require(!certifications[_index].regulatorApproved, "Certificate is already approved");
        certifications[_index].regulatorApproved = true;
        emit CertificateApproved(_index);
    }
}

contract AuditSC {
    // Terms follow the paper (SASBE 2025, pp. 18-21):
    // - a registered auditor is an account the regulator has authorised to take part in audits;
    // - an accepted auditor is the registered auditor the regulator selected for one request;
    //   only it can submit that request's report;
    // - the regulator accepts or rejects a submitted report; rejection reopens submission;
    // - an approved audit is an accepted report that passed ("Approval signifies compliance").
    struct AuditRequest {
        address regulator;
        address manufacturer;
        address[] appliedAuditors; // record of applications (kept after acceptance)
        address acceptedAuditor;
        string reportIPFSHash;
        bool isCompleted; // a report is submitted and not rejected
        bool isAccepted;  // the regulator accepted the submitted report as final
        bool passed;      // the accepted auditor's result
        bool isOpen;      // open for applications
    }

    AuditRequest[] public auditRequests;

    // Registered auditors (the paper: only registered auditors are eligible to apply).
    mapping(address => bool) public isRegisteredAuditor;

    // Whether a registered auditor has applied for a request.
    mapping(uint256 => mapping(address => bool)) public hasApplied;

    event AuditorRegistered(address indexed auditor, bool registered);
    event AuditRequestOpened(address indexed regulator, address indexed manufacturer, uint256 requestId);
    event AuditorApplied(address indexed auditor, uint256 indexed requestId);
    event AuditorAccepted(uint256 indexed requestId, address indexed auditor);
    event AuditReportSubmitted(uint256 indexed requestId, string reportIPFSHash);
    event AuditResultAvailable(uint256 indexed requestId, bool indexed passed);
    event AuditReportAccepted(uint256 indexed requestId, bool indexed passed);
    event AuditReportRejected(uint256 indexed requestId);
    event AuditCompleted(uint256 indexed requestId, bool indexed passed);

    address public immutable regulator;

    modifier onlyRegulator() {
        require(msg.sender == regulator, "Only regulator can perform this action");
        _;
    }

    modifier onlyRegisteredAuditor() {
        require(isRegisteredAuditor[msg.sender], "Only registered auditors can perform this action");
        _;
    }

    modifier requestExists(uint256 _requestId) {
        require(_requestId < auditRequests.length, "Audit request does not exist");
        _;
    }

    constructor() {
        regulator = msg.sender;
    }

    // Regulator registers an auditor, or removes its registration.
    function setRegisteredAuditor(address _auditor, bool _registered) external onlyRegulator {
        require(_auditor != address(0) && _auditor != regulator, "Invalid auditor address");
        isRegisteredAuditor[_auditor] = _registered;
        emit AuditorRegistered(_auditor, _registered);
    }

    // Regulator opens an audit request for a manufacturer and returns its ID.
    function requestAudit(address _manufacturer) external onlyRegulator returns (uint256) {
        require(_manufacturer != address(0), "Invalid manufacturer address");
        uint256 requestId = auditRequests.length;
        AuditRequest storage request = auditRequests.push();
        request.regulator = regulator;
        request.manufacturer = _manufacturer;
        request.isOpen = true;
        emit AuditRequestOpened(regulator, _manufacturer, requestId);
        return requestId;
    }

    // A registered auditor applies once for an open request that is not its own audit.
    function applyForAudit(uint256 _requestId) external requestExists(_requestId) onlyRegisteredAuditor {
        AuditRequest storage request = auditRequests[_requestId];
        require(msg.sender != request.manufacturer, "Auditor cannot be the manufacturer");
        require(request.isOpen, "Audit request is not open for applications");
        require(!hasApplied[_requestId][msg.sender], "Auditor has already applied");
        hasApplied[_requestId][msg.sender] = true;
        request.appliedAuditors.push(msg.sender);
        emit AuditorApplied(msg.sender, _requestId);
    }

    // Regulator accepts one applicant for the request; the request then closes to applications.
    // No loop over applicants, so the call cannot be priced out by many applications.
    function acceptAuditor(uint256 _requestId, address _auditor) external onlyRegulator requestExists(_requestId) {
        AuditRequest storage request = auditRequests[_requestId];
        require(request.isOpen, "Audit request is not open for applications");
        require(hasApplied[_requestId][_auditor], "Auditor did not apply for this request");
        require(isRegisteredAuditor[_auditor], "Auditor is no longer registered");
        request.acceptedAuditor = _auditor;
        request.isOpen = false;
        emit AuditorAccepted(_requestId, _auditor);
    }

    // The accepted auditor submits one report; a rejected report may be resubmitted.
    function submitAuditReport(uint256 _requestId, string memory _reportIPFSHash, bool _passed) external requestExists(_requestId) onlyRegisteredAuditor {
        AuditRequest storage request = auditRequests[_requestId];
        require(request.acceptedAuditor != address(0), "Audit request is not approved yet");
        require(msg.sender == request.acceptedAuditor, "Only accepted auditor can submit report");
        require(!request.isCompleted, "Audit report already submitted");
        request.reportIPFSHash = _reportIPFSHash;
        request.isCompleted = true;
        request.passed = _passed;
        emit AuditReportSubmitted(_requestId, _reportIPFSHash);
        emit AuditResultAvailable(_requestId, _passed);
    }

    // Regulator accepts the submitted report as final, whether it passed or failed.
    function acceptAuditReport(uint256 _requestId) external onlyRegulator requestExists(_requestId) {
        AuditRequest storage request = _submittedReport(_requestId);
        request.isAccepted = true;
        emit AuditReportAccepted(_requestId, request.passed);
        emit AuditCompleted(_requestId, request.passed);
    }

    // Regulator rejects the submitted report as inadequate; the accepted auditor may resubmit.
    function rejectAuditReport(uint256 _requestId) external onlyRegulator requestExists(_requestId) {
        AuditRequest storage request = _submittedReport(_requestId);
        request.isCompleted = false;
        request.passed = false;
        emit AuditReportRejected(_requestId);
    }

    function _submittedReport(uint256 _requestId) private view returns (AuditRequest storage request) {
        request = auditRequests[_requestId];
        require(!request.isAccepted, "Audit report is already accepted");
        require(request.isCompleted, "Audit request is not completed yet");
    }

    // An approved audit: the regulator accepted a report that passed.
    function isAuditApproved(uint256 _requestId) external view requestExists(_requestId) returns (bool) {
        AuditRequest storage request = auditRequests[_requestId];
        return request.isAccepted && request.passed;
    }
}
