'use strict';

const path = require('path');
const fs = require('fs');
const { safeStorage } = require('electron');

/**
 * Encrypted credential storage. On Windows this delegates to DPAPI via Electron's
 * safeStorage, which ties the ciphertext to the current user account.
 */
class CredentialStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'credentials.bin');
  }

  available() {
    return safeStorage.isEncryptionAvailable();
  }

  load() {
    if (!fs.existsSync(this.file)) return null;
    try {
      const buf = fs.readFileSync(this.file);
      if (!buf || buf.length === 0) return null;
      const json = safeStorage.decryptString(buf);
      return JSON.parse(json);
    } catch (err) {
      // If decryption fails (e.g. user profile changed), surface as missing
      return null;
    }
  }

  save(creds) {
    const json = JSON.stringify(creds);
    const enc = safeStorage.encryptString(json);
    fs.writeFileSync(this.file, enc, { mode: 0o600 });
  }

  clear() {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

module.exports = { CredentialStore };
