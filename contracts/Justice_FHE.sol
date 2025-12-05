pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract JusticeFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    address public owner;
    mapping(address => bool) public isProvider;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;
    uint256 public cooldownSeconds = 60; // Default cooldown: 1 minute

    bool public paused = false;

    struct Evidence {
        euint32 encryptedEvidenceId;
        euint32 encryptedEvidenceType;
        euint32 encryptedEvidenceData;
    }
    mapping(uint256 => Evidence[]) public batchEvidences; // batchId => Evidence[]

    struct Vote {
        euint32 encryptedVoteValue;
        ebool encryptedVoteValid;
    }
    mapping(uint256 => mapping(address => Vote)) public batchVotes; // batchId => provider => Vote

    struct DecryptionContext {
        uint256 batchId;
        bytes32 stateHash;
        bool processed;
    }
    mapping(uint256 => DecryptionContext) public decryptionContexts; // requestId => DecryptionContext

    uint256 public currentBatchId = 0;
    bool public currentBatchOpen = false;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address _user, mapping(address => uint256) storage _lastActionTime) {
        if (block.timestamp < _lastActionTime[_user] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event CooldownSecondsUpdated(uint256 oldCooldown, uint256 newCooldown);
    event ContractPaused(address indexed account);
    event ContractUnpaused(address indexed account);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event EvidenceSubmitted(address indexed provider, uint256 indexed batchId, uint256 evidenceIndex);
    event VoteSubmitted(address indexed provider, uint256 indexed batchId);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, uint256 totalValidVotes, uint256 totalVoteSum);

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchNotOpen();
    error BatchClosedOrDoesNotExist();
    error AlreadyVoted();
    error ReplayAttempt();
    error StateMismatch();
    error InvalidBatchId();
    error InvalidCooldown();

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function transferOwnership(address newOwner_) external onlyOwner {
        address previousOwner = owner;
        owner = newOwner_;
        emit OwnershipTransferred(previousOwner, newOwner_);
    }

    function addProvider(address provider_) external onlyOwner {
        if (provider_ == address(0)) revert NotProvider();
        isProvider[provider_] = true;
        emit ProviderAdded(provider_);
    }

    function removeProvider(address provider_) external onlyOwner {
        if (!isProvider[provider_]) revert NotProvider();
        delete isProvider[provider_];
        emit ProviderRemoved(provider_);
    }

    function setCooldownSeconds(uint256 cooldownSeconds_) external onlyOwner {
        if (cooldownSeconds_ == 0) revert InvalidCooldown();
        uint256 oldCooldown = cooldownSeconds;
        cooldownSeconds = cooldownSeconds_;
        emit CooldownSecondsUpdated(oldCooldown, cooldownSeconds_);
    }

    function pause() external onlyOwner whenNotPaused {
        paused = true;
        emit ContractPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        if (!paused) revert Paused(); // Revert if already unpaused
        paused = false;
        emit ContractUnpaused(msg.sender);
    }

    function openBatch() external onlyOwner whenNotPaused {
        if (currentBatchOpen) revert BatchNotOpen(); // Cannot open if one is already open
        currentBatchId++;
        currentBatchOpen = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch() external onlyOwner whenNotPaused {
        if (!currentBatchOpen) revert BatchClosedOrDoesNotExist();
        currentBatchOpen = false;
        emit BatchClosed(currentBatchId);
    }

    function submitEvidence(
        euint32 encryptedEvidenceId_,
        euint32 encryptedEvidenceType_,
        euint32 encryptedEvidenceData_
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!currentBatchOpen) revert BatchClosedOrDoesNotExist();

        _initIfNeeded(encryptedEvidenceId_);
        _initIfNeeded(encryptedEvidenceType_);
        _initIfNeeded(encryptedEvidenceData_);

        Evidence memory newEvidence = Evidence({
            encryptedEvidenceId: encryptedEvidenceId_,
            encryptedEvidenceType: encryptedEvidenceType_,
            encryptedEvidenceData: encryptedEvidenceData_
        });
        batchEvidences[currentBatchId].push(newEvidence);

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit EvidenceSubmitted(msg.sender, currentBatchId, batchEvidences[currentBatchId].length - 1);
    }

    function submitVote(euint32 encryptedVoteValue_, euint32 encryptedVoteType_)
        external
        onlyProvider
        whenNotPaused
        respectCooldown(msg.sender, lastSubmissionTime)
    {
        if (!currentBatchOpen) revert BatchClosedOrDoesNotExist();
        if (batchVotes[currentBatchId][msg.sender].encryptedVoteValid.isInitialized()) {
            revert AlreadyVoted();
        }

        _initIfNeeded(encryptedVoteValue_);
        _initIfNeeded(encryptedVoteType_);

        ebool memory encryptedVoteValid = FHE.isInitialized(encryptedVoteValue_);
        batchVotes[currentBatchId][msg.sender] = Vote({
            encryptedVoteValue: encryptedVoteValue_,
            encryptedVoteValid: encryptedVoteValid
        });

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit VoteSubmitted(msg.sender, currentBatchId);
    }

    function requestBatchResultDecryption(uint256 batchId_)
        external
        onlyOwner
        whenNotPaused
        respectCooldown(msg.sender, lastDecryptionRequestTime)
    {
        if (batchId_ == 0 || batchId_ > currentBatchId || currentBatchOpen) {
            revert InvalidBatchId();
        }

        euint32 memory encryptedTotalValidVotes = FHE.asEuint32(0);
        euint32 memory encryptedTotalVoteSum = FHE.asEuint32(0);

        uint256 numVotes = 0;
        for (uint256 i = 0; i < batchEvidences[batchId_].length; i++) {
            Evidence memory evidence = batchEvidences[batchId_];
            // This example sums evidence IDs if evidence type is 1. Real logic would be more complex.
            ebool memory condition = evidence.encryptedEvidenceType.eq(FHE.asEuint32(1));
            encryptedTotalVoteSum = encryptedTotalVoteSum.add(evidence.encryptedEvidenceId.mul(condition.toEuint32()));
            encryptedTotalValidVotes = encryptedTotalValidVotes.add(condition.toEuint32());
            numVotes++;
        }
        if (numVotes == 0) {
            // If no votes/evidence, use default initialized values
            encryptedTotalValidVotes = FHE.asEuint32(0);
            encryptedTotalVoteSum = FHE.asEuint32(0);
        }


        bytes32[] memory cts = new bytes32[](2);
        cts[0] = encryptedTotalValidVotes.toBytes32();
        cts[1] = encryptedTotalVoteSum.toBytes32();

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: batchId_,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, batchId_);
    }

    function myCallback(
        uint256 requestId_,
        bytes memory cleartexts_,
        bytes memory proof_
    ) public {
        if (decryptionContexts[requestId_].processed) {
            revert ReplayAttempt();
        }

        // Rebuild ciphertexts array in the exact same order as in requestBatchResultDecryption
        euint32 memory currentEncryptedTotalValidVotes = FHE.asEuint32(0);
        euint32 memory currentEncryptedTotalVoteSum = FHE.asEuint32(0);

        uint256 batchIdForRehash = decryptionContexts[requestId_].batchId;
        uint256 numVotesForRehash = batchEvidences[batchIdForRehash].length;

        if (numVotesForRehash > 0) {
            for (uint256 i = 0; i < numVotesForRehash; i++) {
                Evidence memory evidence = batchEvidences[batchIdForRehash][i];
                ebool memory condition = evidence.encryptedEvidenceType.eq(FHE.asEuint32(1));
                currentEncryptedTotalVoteSum = currentEncryptedTotalVoteSum.add(evidence.encryptedEvidenceId.mul(condition.toEuint32()));
                currentEncryptedTotalValidVotes = currentEncryptedTotalValidVotes.add(condition.toEuint32());
            }
        } else {
            currentEncryptedTotalValidVotes = FHE.asEuint32(0);
            currentEncryptedTotalVoteSum = FHE.asEuint32(0);
        }


        bytes32[] memory currentCts = new bytes32[](2);
        currentCts[0] = currentEncryptedTotalValidVotes.toBytes32();
        currentCts[1] = currentEncryptedTotalVoteSum.toBytes32();

        bytes32 currentStateHash = _hashCiphertexts(currentCts);

        if (currentStateHash != decryptionContexts[requestId_].stateHash) {
            revert StateMismatch();
        }

        FHE.checkSignatures(requestId_, cleartexts_, proof_);

        uint256 totalValidVotes = abi.decode(cleartexts_, (uint256));
        uint256 totalVoteSum;
        assembly {
            totalVoteSum := mload(add(add(cleartexts_, 0x20), 0x20))
        }

        decryptionContexts[requestId_].processed = true;
        emit DecryptionCompleted(requestId_, decryptionContexts[requestId_].batchId, totalValidVotes, totalVoteSum);
    }

    function _hashCiphertexts(bytes32[] memory cts_) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts_, address(this)));
    }

    function _initIfNeeded(euint32 memory val_) internal pure {
        val_.isInitialized();
    }

    function _initIfNeeded(ebool memory val_) internal pure {
        val_.isInitialized();
    }
}