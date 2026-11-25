export interface AgentAddressWorker {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

export interface Env {
  ADDRESS_WORKER: AgentAddressWorker;
  MCP_WORKER: AgentAddressWorker;
  DB: D1Database;
  INBOX_STREAM: DurableObjectNamespace;
  ADDRESS_API_URL: string;
  MAILTRIGGER_API_URL: string;
  MAILTRIGGER_AUTH_SCHEME?: string;
  MAILTRIGGER_API_TOKEN?: string;
  MAILTRIGGER_MANAGED_DOMAIN?: string;
  ALIAS_VERIFICATION_KEY?: string;
  MAILTRIGGER_INBOUND_KEY?: string;
  MAILTRIGGER_RECEIPT_URL?: string;
  WAKE_CREDENTIALS_KEY?: string;
}
