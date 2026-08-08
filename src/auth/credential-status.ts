export type CodexAuthState =
  | "ready"
  | "not_found"
  | "invalid"
  | "expired"
  | "unauthorized"
  | "unsupported_storage";

export interface PublicCredentialStatus {
  state: CodexAuthState;
  source: string;
  expiresAt?: string;
  accountIdPresent?: boolean;
  message?: string;
}

export interface CodexCredential {
  accessToken: string;
  accountId: string;
  expiresAt: Date;
  isFedramp: boolean;
  source: string;
}
