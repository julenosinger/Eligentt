/**
 * Autonoma Agent Identity — ERC-8004 Agent Identity Registration & Management
 * Registers Autonoma on Arc as an ERC-8004 AI Agent.
 * Manages Agent Name, Description, Identity NFT, Verification.
 * Attached to window.AgentIdentity
 */
(function(){
  'use strict';

  var ARC_RPC = 'https://arc-testnet.drpc.org';
  var ARC_CHAIN_ID = 5042002;

  // ERC-8004 contract addresses on Arc Testnet
  var IDENTITY_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
  var REPUTATION_REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
  var VALIDATION_REGISTRY = '0x8004Cb1BF31DAf7788923b405b754f57acEB4272';

  var IDENTITY_KEY = 'elligentt_agent_identity_v1';
  var identity = null;

  function loadIdentity(){
    try {
      var raw=localStorage.getItem(IDENTITY_KEY);
      if(raw) identity=JSON.parse(raw);
    } catch(e){ identity=null; }
    if(!identity){
      identity={
        agentName:'Autonoma',
        description:'AI-powered autonomous execution agent for Elligentt. Manages swaps, bridges, treasury, payments, and cross-chain operations with delegated authorization.',
        developer:'Elligentt',
        version:'1.0.0',
        metadataURI:'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei',
        walletAddress:null,
        identityNFT:null,
        registrationTx:null,
        tokenId:null,
        capabilities:[
          'swap_execution','bridge_operations','treasury_management',
          'payment_processing','contract_interaction','vault_operations',
          'crosschain_transfers','permit_management','recurring_payments',
          'scheduled_operations','automatic_reimbursements','treasury_deposits'
        ],
        verificationStatus:'unverified',
        registeredAt:null
      };
      saveIdentity();
    }
    return identity;
  }

  function saveIdentity(){
    try { localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity)); } catch(e){}
  }

  function setIdentityData(data){
    if(!identity) loadIdentity();
    var keys=Object.keys(data);
    for(var i=0;i<keys.length;i++){ identity[keys[i]]=data[keys[i]]; }
    saveIdentity();
  }

  function setWalletAddress(addr){
    if(!identity) loadIdentity();
    identity.walletAddress=addr; saveIdentity();
  }

  function registerOnChain(tokenId, txHash, metadataURI){
    if(!identity) loadIdentity();
    identity.tokenId=tokenId;
    identity.registrationTx=txHash;
    identity.identityNFT=tokenId?'ERC-8004 Token #'+tokenId:null;
    identity.metadataURI=metadataURI||identity.metadataURI;
    identity.registeredAt=Date.now();
    identity.verificationStatus='registered';
    saveIdentity();

    // Sync with AgentWalletManager
    if(typeof AgentWalletManager!=='undefined'){
      AgentWalletManager.registerIdentity(tokenId, txHash, metadataURI);
    }

    return identity;
  }

  function setVerificationStatus(status){
    if(!identity) loadIdentity();
    identity.verificationStatus=status; saveIdentity();
  }

  /* ── ERC-8004 Identity Registry ABI ── */
  function getIdentityRegistryABI(){
    return [
      { name:'register', type:'function', stateMutability:'nonpayable', inputs:[{ name:'metadataURI', type:'string' }], outputs:[] },
      { name:'ownerOf', type:'function', stateMutability:'view', inputs:[{ name:'tokenId', type:'uint256' }], outputs:[{ name:'', type:'address' }] },
      { name:'tokenURI', type:'function', stateMutability:'view', inputs:[{ name:'tokenId', type:'uint256' }], outputs:[{ name:'', type:'string' }] },
      { name:'balanceOf', type:'function', stateMutability:'view', inputs:[{ name:'owner', type:'address' }], outputs:[{ name:'', type:'uint256' }] },
      { anonymous:false, name:'Transfer', type:'event', inputs:[
        { indexed:true, name:'from', type:'address' }, { indexed:true, name:'to', type:'address' },
        { indexed:true, name:'tokenId', type:'uint256' }
      ]}
    ];
  }

  /* ── On-chain registration (requires agent wallet with ARC gas) ── */
  async function registerOnChainIdentity(agentSigner, metadataURI){
    if(typeof ethers==='undefined') throw new Error('ethers.js not loaded');
    if(!agentSigner) throw new Error('Agent signer required');

    var uri=metadataURI||(identity?identity.metadataURI:'ipfs://bafkreibdi6623n3xpf7ymk62ckb4bo75o3qemwkpfvp5i25j66itxvsoei');
    var registryContract=new ethers.Contract(IDENTITY_REGISTRY, getIdentityRegistryABI(), agentSigner);

    var tx=await registryContract.register(uri);
    var receipt=await tx.wait();

    // Find tokenId from Transfer event
    var tokenId=null;
    for(var i=0;i<receipt.logs.length;i++){
      try {
        var parsed=registryContract.interface.parseLog({ topics:receipt.logs[i].topics, data:receipt.logs[i].data });
        if(parsed&&parsed.name==='Transfer'){
          tokenId=parsed.args.tokenId.toString();
          break;
        }
      }catch(e){}
    }

    if(tokenId){
      registerOnChain(tokenId, receipt.hash, uri);
    }

    return {
      tokenId:tokenId,
      txHash:receipt.hash,
      metadataURI:uri
    };
  }

  /* ── Query on-chain identity ── */
  async function queryIdentity(tokenId){
    if(typeof ethers==='undefined') throw new Error('ethers.js not loaded');
    var provider=new ethers.JsonRpcProvider(ARC_RPC);
    var registryContract=new ethers.Contract(IDENTITY_REGISTRY, getIdentityRegistryABI(), provider);

    var owner=await registryContract.ownerOf(tokenId);
    var tokenURI=await registryContract.tokenURI(tokenId);

    return {
      tokenId:tokenId,
      owner:owner,
      metadataURI:tokenURI
    };
  }

  /* ── Reputation Registry ABI ── */
  function getReputationRegistryABI(){
    return [
      { name:'giveFeedback', type:'function', stateMutability:'nonpayable', inputs:[
        { name:'agentId', type:'uint256' }, { name:'score', type:'int128' }, { name:'domain', type:'uint8' },
        { name:'tag', type:'string' }, { name:'meta', type:'string' }, { name:'proofURI', type:'string' },
        { name:'version', type:'string' }, { name:'feedbackHash', type:'bytes32' }
      ], outputs:[] },
      { name:'getFeedback', type:'function', stateMutability:'view', inputs:[{ name:'agentId', type:'uint256' }], outputs:[
        { name:'totalScore', type:'int128' }, { name:'count', type:'uint256' }, { name:'domainCount', type:'uint8[]' }
      ]}
    ];
  }

  /* ── Validation Registry ABI ── */
  function getValidationRegistryABI(){
    return [
      { name:'validationRequest', type:'function', stateMutability:'nonpayable', inputs:[
        { name:'validator', type:'address' }, { name:'agentId', type:'uint256' },
        { name:'requestURI', type:'string' }, { name:'requestHash', type:'bytes32' }
      ], outputs:[] },
      { name:'validationResponse', type:'function', stateMutability:'nonpayable', inputs:[
        { name:'requestHash', type:'bytes32' }, { name:'response', type:'uint8' },
        { name:'responseURI', type:'string' }, { name:'responseHash', type:'bytes32' },
        { name:'tag', type:'string' }
      ], outputs:[] },
      { name:'getValidationStatus', type:'function', stateMutability:'view', inputs:[{ name:'requestHash', type:'bytes32' }], outputs:[
        { name:'validatorAddress', type:'address' }, { name:'agentId', type:'uint256' }, { name:'response', type:'uint8' },
        { name:'responseHash', type:'bytes32' }, { name:'tag', type:'string' }, { name:'lastUpdate', type:'uint256' }
      ]}
    ];
  }

  /* ── Build metadata JSON for registration ── */
  function buildMetadataJSON(customFields){
    if(!identity) loadIdentity();
    var meta={
      name:identity.agentName,
      description:identity.description,
      agent_type:'autonomous_execution',
      capabilities:identity.capabilities,
      version:identity.version,
      developer:identity.developer
    };
    if(customFields){
      var keys=Object.keys(customFields);
      for(var i=0;i<keys.length;i++){ meta[keys[i]]=customFields[keys[i]]; }
    }
    return meta;
  }

  function getFullIdentity(){
    if(!identity) loadIdentity();
    var id=JSON.parse(JSON.stringify(identity));

    // Merge with AgentWalletManager state
    if(typeof AgentWalletManager!=='undefined'){
      var awmState=AgentWalletManager.getFullState();
      id.walletAddress=id.walletAddress||awmState.walletAddress;
      if(awmState.identityTokenId) id.tokenId=awmState.identityTokenId;
      if(awmState.identityTxHash) id.registrationTx=awmState.registrationTx;
    }

    return id;
  }

  function getDisplayIdentity(){
    var id=getFullIdentity();
    return {
      name:id.agentName,
      description:id.description,
      developer:id.developer,
      version:id.version,
      wallet:id.walletAddress,
      identityNFT:id.identityNFT,
      registrationTx:id.registrationTx,
      capabilities:id.capabilities,
      verificationStatus:id.verificationStatus,
      registeredAt:id.registeredAt,
      metadataURI:id.metadataURI,
      tokenId:id.tokenId
    };
  }

  function isRegistered(){
    if(!identity) loadIdentity();
    return !!(identity&&identity.tokenId);
  }

  loadIdentity();

  window.AgentIdentity = {
    // Data management
    setIdentityData:setIdentityData,
    setWalletAddress:setWalletAddress,
    registerOnChain:registerOnChain,
    setVerificationStatus:setVerificationStatus,

    // On-chain operations
    registerOnChainIdentity:registerOnChainIdentity,
    queryIdentity:queryIdentity,

    // Getters
    getFullIdentity:getFullIdentity,
    getDisplayIdentity:getDisplayIdentity,
    buildMetadataJSON:buildMetadataJSON,
    isRegistered:isRegistered,

    // Contract ABIs
    getIdentityRegistryABI:getIdentityRegistryABI,
    getReputationRegistryABI:getReputationRegistryABI,
    getValidationRegistryABI:getValidationRegistryABI,

    // Contract addresses
    IDENTITY_REGISTRY:IDENTITY_REGISTRY,
    REPUTATION_REGISTRY:REPUTATION_REGISTRY,
    VALIDATION_REGISTRY:VALIDATION_REGISTRY,
    ARC_RPC:ARC_RPC,
    ARC_CHAIN_ID:ARC_CHAIN_ID
  };
})();

