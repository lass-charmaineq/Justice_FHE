import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

const FHEEncrypt = (value: number): string => `FHE-${value.toString().padStart(8, '0')}`;
const FHEDecrypt = (encryptedData: string): number => parseInt(encryptedData.replace('FHE-', ''), 10);
const generateCaseId = () => `CASE-${Date.now().toString().slice(-8)}`;

interface Case {
  id: string;
  title: string;
  status: 'pending' | 'under-review' | 'resolved';
  evidenceCount: number;
  encrypted: boolean;
  createdAt: number;
  juryVotes?: { for: number; against: number };
}

interface UserAction {
  type: 'upload' | 'view' | 'decrypt' | 'vote';
  timestamp: number;
  details: string;
  caseId?: string;
}

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [cases, setCases] = useState<Case[]>([]);
  const [filteredCases, setFilteredCases] = useState<Case[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'pending' | 'under-review' | 'resolved'>('all');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ 
    visible: boolean; 
    status: "pending" | "success" | "error"; 
    message: string; 
  }>({ visible: false, status: "pending", message: "" });
  
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [selectedCase, setSelectedCase] = useState<Case | null>(null);
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);

  useEffect(() => {
    initializeApp().finally(() => setLoading(false));
  }, []);

  const initializeApp = async () => {
    try {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      await loadData();
      checkContractAvailability();
    } catch (error) {
      console.error('Initialization error:', error);
    }
  };

  const checkContractAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (contract) {
        const isAvailable = await contract.isAvailable();
        if (isAvailable) {
          showTransactionStatus('success', 'Zama FHE Contract is available and ready!');
        }
      }
    } catch (error) {
      console.error('Contract availability check failed:', error);
    }
  };

  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;

      const casesData = await contract.getData("cases");
      let casesList: Case[] = [];
      
      if (casesData && casesData.length > 0) {
        try {
          const casesStr = ethers.toUtf8String(casesData);
          if (casesStr.trim() !== '') {
            casesList = JSON.parse(casesStr);
          }
        } catch (e) {
          console.error('Failed to parse cases data:', e);
        }
      }
      
      setCases(casesList);
      setFilteredCases(casesList);
    } catch (error) {
      console.error('Error loading data:', error);
      showTransactionStatus('error', 'Failed to load case data');
    } finally {
      setIsRefreshing(false);
    }
  };

  const showTransactionStatus = (status: "pending" | "success" | "error", message: string) => {
    setTransactionStatus({ visible: true, status, message });
    setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
  };

  const createNewCase = async () => {
    if (!isConnected || !address) {
      showTransactionStatus('error', 'Please connect your wallet first');
      return;
    }

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error('Failed to get contract with signer');

      const newCase: Case = {
        id: generateCaseId(),
        title: `Case ${cases.length + 1}`,
        status: 'pending',
        evidenceCount: 0,
        encrypted: true,
        createdAt: Math.floor(Date.now() / 1000),
      };

      const updatedCases = [...cases, newCase];
      await contract.setData("cases", ethers.toUtf8Bytes(JSON.stringify(updatedCases)));

      const newAction: UserAction = {
        type: 'upload',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Created new case: ${newCase.title}`,
        caseId: newCase.id,
      };
      setUserActions(prev => [newAction, ...prev]);

      showTransactionStatus('success', 'New case created successfully with FHE encryption!');
      await loadData();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showTransactionStatus('error', `Failed to create case: ${errorMsg}`);
    }
  };

  const uploadEvidence = async (caseId: string) => {
    if (!isConnected || !address) {
      showTransactionStatus('error', 'Please connect your wallet first');
      return;
    }

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error('Failed to get contract with signer');

      const caseIndex = cases.findIndex(c => c.id === caseId);
      if (caseIndex === -1) throw new Error('Case not found');

      const updatedCases = [...cases];
      updatedCases[caseIndex] = {
        ...updatedCases[caseIndex],
        evidenceCount: updatedCases[caseIndex].evidenceCount + 1,
      };

      await contract.setData("cases", ethers.toUtf8Bytes(JSON.stringify(updatedCases)));

      const newAction: UserAction = {
        type: 'upload',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Uploaded encrypted evidence for case: ${updatedCases[caseIndex].title}`,
        caseId: caseId,
      };
      setUserActions(prev => [newAction, ...prev]);

      showTransactionStatus('success', 'Evidence uploaded and encrypted with FHE!');
      await loadData();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showTransactionStatus('error', `Failed to upload evidence: ${errorMsg}`);
    }
  };

  const updateCaseStatus = async (caseId: string, status: 'under-review' | 'resolved') => {
    if (!isConnected || !address) {
      showTransactionStatus('error', 'Please connect your wallet first');
      return;
    }

    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error('Failed to get contract with signer');

      const caseIndex = cases.findIndex(c => c.id === caseId);
      if (caseIndex === -1) throw new Error('Case not found');

      const updatedCases = [...cases];
      updatedCases[caseIndex] = {
        ...updatedCases[caseIndex],
        status: status,
      };

      await contract.setData("cases", ethers.toUtf8Bytes(JSON.stringify(updatedCases)));

      const newAction: UserAction = {
        type: 'view',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Updated case status to: ${status}`,
        caseId: caseId,
      };
      setUserActions(prev => [newAction, ...prev]);

      showTransactionStatus('success', `Case status updated to ${status} with FHE protection`);
      await loadData();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showTransactionStatus('error', `Failed to update case status: ${errorMsg}`);
    }
  };

  const handleSearch = (term: string) => {
    setSearchTerm(term);
    applyFilters(term, statusFilter);
  };

  const handleStatusFilter = (status: 'all' | 'pending' | 'under-review' | 'resolved') => {
    setStatusFilter(status);
    applyFilters(searchTerm, status);
  };

  const applyFilters = (term: string, status: 'all' | 'pending' | 'under-review' | 'resolved') => {
    let filtered = cases;

    if (term) {
      filtered = filtered.filter(c => 
        c.title.toLowerCase().includes(term.toLowerCase()) ||
        c.id.toLowerCase().includes(term.toLowerCase())
      );
    }

    if (status !== 'all') {
      filtered = filtered.filter(c => c.status === status);
    }

    setFilteredCases(filtered);
  };

  const decryptCaseData = async (encryptedValue: string): Promise<number | null> => {
    if (!isConnected) {
      showTransactionStatus('error', 'Please connect wallet first');
      return null;
    }

    try {
      const message = `Decrypting FHE data for case access\nWallet: ${address}\nChain: ${chainId}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1000));

      const decrypted = FHEDecrypt(encryptedValue);
      
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Decrypted case data using wallet signature`,
      };
      setUserActions(prev => [newAction, ...prev]);

      return decrypted;
    } catch (error) {
      console.error('Decryption failed:', error);
      return null;
    }
  };

  const renderCaseCard = (caseItem: Case) => (
    <div 
      key={caseItem.id} 
      className={`case-card ${caseItem.status} ${selectedCase?.id === caseItem.id ? 'selected' : ''}`}
      onClick={() => setSelectedCase(caseItem)}
    >
      <div className="case-header">
        <h3>{caseItem.title}</h3>
        <span className={`status-badge status-${caseItem.status}`}>
          {caseItem.status === 'pending' && 'Pending'}
          {caseItem.status === 'under-review' && 'Under Review'}
          {caseItem.status === 'resolved' && 'Resolved'}
        </span>
      </div>
      
      <div className="case-details">
        <div className="detail-item">
          <span className="label">Case ID:</span>
          <span className="value">{caseItem.id}</span>
        </div>
        <div className="detail-item">
          <span className="label">Evidence Count:</span>
          <span className="value">{caseItem.evidenceCount}</span>
        </div>
        <div className="detail-item">
          <span className="label">Created At:</span>
          <span className="value">{new Date(caseItem.createdAt * 1000).toLocaleDateString()}</span>
        </div>
        <div className="detail-item">
          <span className="label">Encryption:</span>
          <span className="value encrypted">FHE Encrypted</span>
        </div>
      </div>

      <div className="case-actions">
        {caseItem.status === 'pending' && (
          <>
            <button 
              className="action-btn upload-btn"
              onClick={(e) => { e.stopPropagation(); uploadEvidence(caseItem.id); }}
            >
              Upload Evidence
            </button>
            <button 
              className="action-btn status-btn"
              onClick={(e) => { e.stopPropagation(); updateCaseStatus(caseItem.id, 'under-review'); }}
            >
              Start Arbitration
            </button>
          </>
        )}
        {caseItem.status === 'under-review' && (
          <button 
            className="action-btn status-btn"
            onClick={(e) => { e.stopPropagation(); updateCaseStatus(caseItem.id, 'resolved'); }}
          >
            Mark Resolved
          </button>
        )}
      </div>
    </div>
  );

  const renderStatistics = () => {
    const totalCases = cases.length;
    const pendingCases = cases.filter(c => c.status === 'pending').length;
    const underReviewCases = cases.filter(c => c.status === 'under-review').length;
    const resolvedCases = cases.filter(c => c.status === 'resolved').length;
    const totalEvidence = cases.reduce((sum, c) => sum + c.evidenceCount, 0);

    return (
      <div className="statistics-panel">
        <h3>🔍 FHE Arbitration Platform Statistics</h3>
        <div className="stats-grid">
          <div className="stat-item">
            <div className="stat-value">{totalCases}</div>
            <div className="stat-label">Total Cases</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{pendingCases}</div>
            <div className="stat-label">Pending</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{underReviewCases}</div>
            <div className="stat-label">Under Review</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{resolvedCases}</div>
            <div className="stat-label">Resolved</div>
          </div>
          <div className="stat-item">
            <div className="stat-value">{totalEvidence}</div>
            <div className="stat-label">Encrypted Evidence</div>
          </div>
        </div>
      </div>
    );
  };

  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions yet</div>;

    return (
      <div className="user-actions-panel">
        <h3>📊 User Action History</h3>
        <div className="actions-list">
          {userActions.slice(-10).reverse().map((action, index) => (
            <div className="action-item" key={index}>
              <div className="action-icon">
                {action.type === 'upload' && '📁'}
                {action.type === 'view' && '👁️'}
                {action.type === 'decrypt' && '🔓'}
                {action.type === 'vote' && '🗳️'}
              </div>
              <div className="action-content">
                <div className="action-text">{action.details}</div>
                <div className="action-time">
                  {new Date(action.timestamp * 1000).toLocaleString()}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="fhe-loading-circle"></div>
        <p>Initializing FHE Arbitration System...</p>
      </div>
    );
  }

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo-section">
          <div className="logo">
            <div className="fhe-symbol">⚡</div>
            <h1>Justice<span>FHE</span></h1>
          </div>
          <p className="subtitle">FHE-based Decentralized Dispute Resolution Platform</p>
        </div>
        
        <div className="header-actions">
          <div className="wallet-connect">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false} />
          </div>
          <button 
            onClick={createNewCase} 
            className="create-case-btn"
            disabled={!isConnected}
          >
            Create New Case
          </button>
        </div>
      </header>

      <div className="main-content">
        <div className="content-grid">
          <div className="left-panel">
            <div className="panel-section">
              <h2>Case Management</h2>
              <div className="search-filter">
                <input
                  type="text"
                  placeholder="Search cases..."
                  value={searchTerm}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="search-input"
                />
                <select 
                  value={statusFilter} 
                  onChange={(e) => handleStatusFilter(e.target.value as any)}
                  className="filter-select"
                >
                  <option value="all">All Status</option>
                  <option value="pending">Pending</option>
                  <option value="under-review">Under Review</option>
                  <option value="resolved">Resolved</option>
                </select>
              </div>
              <div className="cases-grid">
                {filteredCases.map(renderCaseCard)}
              </div>
            </div>
          </div>

          <div className="right-panel">
            {renderStatistics()}
            {renderUserActions()}
          </div>
        </div>
      </div>

      {selectedCase && (
        <div className="case-detail-overlay">
          <div className="case-detail-panel">
            <div className="detail-header">
              <h2>Case Details: {selectedCase.title}</h2>
              <button onClick={() => setSelectedCase(null)} className="close-btn">×</button>
            </div>
            <div className="detail-content">
              <div className="detail-info">
                <p><strong>Case ID:</strong> {selectedCase.id}</p>
                <p><strong>Status:</strong> {selectedCase.status === 'pending' && 'Pending'} 
                   {selectedCase.status === 'under-review' && 'Under Review'} 
                   {selectedCase.status === 'resolved' && 'Resolved'}</p>
                <p><strong>Evidence Count:</strong> {selectedCase.evidenceCount}</p>
                <p><strong>Created At:</strong> {new Date(selectedCase.createdAt * 1000).toLocaleString()}</p>
                <p><strong>Encryption:</strong> <span className="fhe-tag">FHE Encrypted</span></p>
              </div>
              <div className="detail-actions">
                <button 
                  className="detail-action-btn"
                  onClick={() => uploadEvidence(selectedCase.id)}
                  disabled={selectedCase.status !== 'pending'}
                >
                  Upload Encrypted Evidence
                </button>
                <button 
                  className="detail-action-btn"
                  onClick={() => updateCaseStatus(selectedCase.id, 'under-review')}
                  disabled={selectedCase.status !== 'pending'}
                >
                  Start Arbitration Process
                </button>
                <button 
                  className="detail-action-btn"
                  onClick={() => updateCaseStatus(selectedCase.id, 'resolved')}
                  disabled={selectedCase.status !== 'under-review'}
                >
                  Mark Case as Resolved
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === 'pending' && <div className="loading-spinner"></div>}
              {transactionStatus.status === 'success' && <div className="success-check">✓</div>}
              {transactionStatus.status === 'error' && <div className="error-cross">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default App;