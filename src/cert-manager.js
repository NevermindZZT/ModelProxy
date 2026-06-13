const fs = require('fs');
const path = require('path');
const forge = require('node-forge');
const logger = require('./logger');

const CERTS_DIR = path.resolve(__dirname, '..', 'certs');
const ROOT_CA_KEY_PATH = path.join(CERTS_DIR, 'root-ca-key.pem');
const ROOT_CA_CERT_PATH = path.join(CERTS_DIR, 'root-ca-cert.pem');
const ROOT_CA_CERT_CRT_PATH = path.join(CERTS_DIR, 'root-ca-cert.crt');
const certCache = new Map();

function ensureCertsDir() {
  if (!fs.existsSync(CERTS_DIR)) fs.mkdirSync(CERTS_DIR, { recursive: true });
}

function getOrCreateRootCA() {
  ensureCertsDir();
  if (fs.existsSync(ROOT_CA_KEY_PATH) && fs.existsSync(ROOT_CA_CERT_PATH)) {
    logger.info('加载已有的根 CA 证书');
    const keyPem = fs.readFileSync(ROOT_CA_KEY_PATH, 'utf-8');
    const certPem = fs.readFileSync(ROOT_CA_CERT_PATH, 'utf-8');
    if (!fs.existsSync(ROOT_CA_CERT_CRT_PATH)) fs.writeFileSync(ROOT_CA_CERT_CRT_PATH, certPem);
    return { key: forge.pki.privateKeyFromPem(keyPem), cert: forge.pki.certificateFromPem(certPem), keyPem, certPem };
  }

  logger.info('生成新的根 CA 证书...');
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01' + Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [{ name: 'commonName', value: 'ModelProxy Root CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
    { name: 'authorityKeyIdentifier', keyIdentifier: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);
  fs.writeFileSync(ROOT_CA_KEY_PATH, keyPem);
  fs.writeFileSync(ROOT_CA_CERT_PATH, certPem);
  fs.writeFileSync(ROOT_CA_CERT_CRT_PATH, certPem);

  logger.info('✅ 根 CA 证书已生成: ' + ROOT_CA_CERT_PATH);
  return { key: keys.privateKey, cert, keyPem, certPem };
}

function generateCertForDomain(rootCA, domain) {
  if (certCache.has(domain)) return certCache.get(domain);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '02' + Date.now().toString(16) + Math.random().toString(16).substring(2, 8);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(rootCA.cert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
  ]);
  cert.sign(rootCA.key, forge.md.sha256.create());

  const result = { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) };
  certCache.set(domain, result);
  return result;
}

module.exports = { getOrCreateRootCA, generateCertForDomain, getRootCACertPath: () => ROOT_CA_CERT_PATH, getRootCACrtPath: () => ROOT_CA_CERT_CRT_PATH };
