// Runs in the page BEFORE any app script (Playwright addInitScript). Plain JS, no imports.
// A Wallet Standard wallet. It holds NO key: it only knows the public key, and delegates signing to Node
// through the Playwright bindings window.__e2eSignTransaction / window.__e2eSignMessage.
(() => {
  const cfg = window.__E2E_WALLET_CFG__; // { address, publicKey:number[], name }
  const publicKey = Uint8Array.from(cfg.publicKey);
  const chains = ['solana:mainnet', 'solana:devnet', 'solana:testnet'];
  const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const account = Object.freeze({
    address: cfg.address, publicKey, chains,
    features: ['solana:signTransaction', 'solana:signMessage'],
  });
  const listeners = { change: [] };
  let connected = false;
  const emit = () => (listeners.change || []).forEach((l) => l({ accounts: connected ? [account] : [] }));
  const wallet = {
    version: '1.0.0',
    name: cfg.name,
    icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMiIgaGVpZ2h0PSIzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiBmaWxsPSIjMGEwIi8+PC9zdmc+',
    chains,
    get accounts() { return connected ? [account] : []; },
    features: {
      'standard:connect': { version: '1.0.0', connect: async () => { connected = true; emit(); return { accounts: [account] }; } },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => { connected = false; emit(); } },
      'standard:events': {
        version: '1.0.0',
        on: (ev, fn) => { (listeners[ev] ||= []).push(fn); return () => { listeners[ev] = listeners[ev].filter((f) => f !== fn); }; },
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0],
        signTransaction: async (...inputs) => {
          (window.__E2E_SIGN_REQUESTS__ ||= []).push(inputs.length);
          return Promise.all(inputs.map(async ({ transaction, account: a, chain }) => {
          if (a.address !== cfg.address) throw new Error('E2E wallet: wrong account');
          const out = await window.__e2eSignTransaction(b64(transaction), chain || null);
          return { signedTransaction: unb64(out) };
          }));
        },
      },
      'solana:signMessage': {
        version: '1.0.0',
        signMessage: async (...inputs) => Promise.all(inputs.map(async ({ message }) => {
          const sig = await window.__e2eSignMessage(b64(message));
          return { signedMessage: message, signature: unb64(sig) };
        })),
      },
    },
  };
  // The spec requires `detail` to be a callback ({ register }) => register(wallet), not the wallet itself.
  class RegisterWalletEvent extends Event {
    #detail;
    get detail() { return this.#detail; }
    constructor(cb) {
      super('wallet-standard:register-wallet', { bubbles: false, cancelable: false, composed: false });
      this.#detail = cb;
    }
  }
  const cb = ({ register }) => register(wallet);
  try { window.dispatchEvent(new RegisterWalletEvent(cb)); } catch (e) { console.warn('e2e wallet register failed', String(e)); }
  window.addEventListener('wallet-standard:app-ready', (e) => cb(e.detail));
})();
