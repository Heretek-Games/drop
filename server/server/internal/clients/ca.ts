import type { CertificateStore } from "./ca-store";
import { CERTIFICATE_KEY_ENV, certificateKeyConfigured } from "./cert-secrets";
import { dropletInterface } from "../services/torrential/droplet-interface";
import { logger } from "../logging";

export type CertificateBundle = {
  priv: string;
  cert: string;
};

let warnedMissingCertificateKey = false;

/*
This is designed to handle client certificates, as described in the README.md
*/
export class CertificateAuthority {
  private readonly certificateStore: CertificateStore;

  private readonly root: CertificateBundle;

  constructor(store: CertificateStore, root: CertificateBundle) {
    this.certificateStore = store;
    this.root = root;
  }

  static async new(store: CertificateStore) {
    if (!certificateKeyConfigured() && !warnedMissingCertificateKey) {
      warnedMissingCertificateKey = true;
      logger.warn(
        `${CERTIFICATE_KEY_ENV} is not set; certificate private keys are stored ` +
          "unencrypted. Set it to a 32-byte key (64 hex characters or base64) " +
          "to seal them at rest.",
      );
    }

    const root = await store.fetch("ca");
    let ca;
    if (root === undefined) {
      const bundle: CertificateBundle = await dropletInterface.generateRootCa();
      await store.store("ca", bundle);
      ca = new CertificateAuthority(store, bundle);
    } else {
      ca = new CertificateAuthority(store, root);
    }

    const serverCertificate = await ca.fetchClientCertificate("server");
    if (!serverCertificate) {
      await ca.generateClientCertificate("server", "Drop Server");
    }

    logger.info("initialised the ca");

    return ca;
  }

  async generateClientCertificate(clientId: string, clientName: string) {
    const caCertificate = await this.certificateStore.fetch("ca");
    if (!caCertificate)
      throw new Error("Certificate authority not initialised");

    const certBundle: CertificateBundle =
      await dropletInterface.generateClientCert(
        clientId,
        clientName,
        caCertificate,
      );
    return certBundle;
  }

  async storeClientCertificate(clientId: string, bundle: CertificateBundle) {
    await this.certificateStore.store(`client:${clientId}`, bundle);
  }

  async fetchClientCertificate(clientId: string) {
    const isBlacklist = await this.certificateStore.checkBlacklistCertificate(
      `client:${clientId}`,
    );
    if (isBlacklist) return undefined;
    return await this.certificateStore.fetch(`client:${clientId}`);
  }

  async blacklistClient(clientId: string) {
    await this.certificateStore.blacklistCertificate(`client:${clientId}`);
  }
}
