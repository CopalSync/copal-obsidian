export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface ClientReg {
  client_id: string;
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  /** Unix ms when the access token expires (derived from `expires_in` at exchange time), if known. */
  expires_at?: number;
}
