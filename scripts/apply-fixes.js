const fs = require('fs');
let html = fs.readFileSync('C:/Users/Juleno/opencode/Eligentt/public/index.original.html', 'utf8');

// Fix 1: calldataPlan ordering — swap card (prepareFullSwap BEFORE fullSwapSim)
const swapOld = 'simData = await ChainSimulator.fullSwapSim(amt, tIn, tOut);\n        calldataPlan = ChainSimulator.prepareFullSwap(amt, tIn, tOut, typeof SWP!';
const swapMid = 'calldataPlan = ChainSimulator.prepareFullSwap(amt, tIn, tOut, typeof SWP!';
const swapEnd = "!== 'undefined' ? Math.round(SWP.slippage * 100) : 100);\n      }";
html = html.replace(swapOld + swapEnd, 
  swapMid + swapEnd.replace('      }', '      }\n        try { simData = await ChainSimulator.fullSwapSim(amt, tIn, tOut); } catch(e2){}'));

// Fix 2: calldataPlan ordering — bridge card
const bridgeOld = 'simData = await ChainSimulator.fullBridgeSim(amt, fromName, toName);\n        calldataPlan = ChainSimulator.prepareFullBridge(amt, destDomain, mintRecipient);';
const bridgeNew = 'calldataPlan = ChainSimulator.prepareFullBridge(amt, destDomain, mintRecipient);\n        try { simData = await ChainSimulator.fullBridgeSim(amt, fromName, toName); } catch(e2){}';
html = html.replace(bridgeOld, bridgeNew);

// Fix 3: _agentAddMsg function
if (!html.includes('function _agentAddMsg')) {
  const before = 'function _agentStateMsg(execId, state, detail){';
  const replacement = 'function _agentAddMsg(msg){ var c=document.getElementById("aut-messages"); if(!c) return; var h="<div class=aut-msg ai><div class=aut-msg-body><div style=background:rgba(167,139,250,.1);border:1px solid rgba(167,139,250,.25);border-radius:8px;padding:10px 14px;font-size:11px;color:var(--text)>"+msg+"</div></div></div>"; c.insertAdjacentHTML("beforeend", h); c.scrollTop=c.scrollHeight; }\n\n  ' + before;
  html = html.replace(before, replacement);
}

// Fix 4: Agent wallet unlock message in _agentExecuteSwap
const swapUnlockOld = 'if(!signer){\n      return;\n      return;\n    }\n    var provider = signer.provider;\n    var agentAddr = signer.address;\n\n    _agentStateMsg(execId, \'PLANNING\', agentAddr.substring(0,8)+\'... \'+amount+\' \'+tokenIn+\' \u2192 \'+tokenOut);';
const swapUnlockNew = 'if(!signer){\n      _agentAddMsg("Agent wallet locked. Unlock it to execute operations.");\n      return;\n    }\n    var provider = signer.provider;\n    var agentAddr = signer.address;\n\n    _agentStateMsg(execId, \'PLANNING\', agentAddr.substring(0,8)+\'... \'+amount+\' \'+tokenIn+\' \u2192 \'+tokenOut);';
html = html.replace(swapUnlockOld, swapUnlockNew);

// Fix 5: Agent wallet unlock message in _agentExecuteOp  
const opUnlockOld = 'var signer = await _agentGetSigner();\n    if(!signer){ return; }';
const opUnlockNew = 'var signer = await _agentGetSigner();\n    if(!signer){ _agentAddMsg("Agent wallet locked. Unlock it to execute operations."); return; }';
html = html.replace(opUnlockOld, opUnlockNew);

// Fix 6: prefers-reduced-motion
if (!html.includes('prefers-reduced-motion')) {
  html = html.replace(
    '@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}',
    '@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}'
  );
}

// Fix 7: bridge card centering
if (!html.includes('#page-bridge .swap-card{max-width:480px;margin:0 auto')) {
  const bridgeCSS = '\n/* Bridge page layout — card centered in available space */\n#page-bridge .swap-card{max-width:480px;margin:0 auto;width:100%}\n</style>';
  html = html.replace('</style>\n</head>', bridgeCSS + '\n</head>');
}

fs.writeFileSync('C:/Users/Juleno/opencode/Eligentt/public/index.original.html', html);
console.log('Applied 7 fixes successfully');
