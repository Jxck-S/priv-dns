export interface Env {
  DNS_ZONES: R2Bucket;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  ALLOWED_HOSTS: string;
  CORS_ORIGINS: string;
  API_TOKEN: string;
  API_TOKEN_NEXT?: string;
  NOTIFY_SECRET?: string;
  /**
   * "true" disables authentication, and only for requests arriving on a
   * loopback hostname. Set it in .dev.vars, never in wrangler.toml.
   */
  DEV_NO_AUTH?: string;
}

export const RECORD_TYPES = [
  'A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS', 'SRV', 'PTR',
] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

export type RecordData =
  | { ip: string }                                            // A, AAAA
  | { target: string }                                        // CNAME, NS, PTR
  | { text: string }                                          // TXT
  | { preference: number; exchange: string }                  // MX
  | { priority: number; weight: number; port: number; target: string }; // SRV

export interface DnsRecord {
  id: string;
  name: string;
  type: RecordType;
  ttl: number;
  data: RecordData;
  comment?: string;
}

export interface Soa {
  mname: string;
  rname: string;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export interface ZoneDoc {
  origin: string;
  serial: number;
  soa: Soa;
  defaultTtl: number;
  records: DnsRecord[];
  updatedAt: string;
  updatedBy: string;
}

export interface ZoneIndexEntry {
  origin: string;
  enabled: boolean;
  notify?: string[];
  description?: string;
}

export interface ZoneIndex {
  zones: ZoneIndexEntry[];
}

export interface Identity {
  subject: string;
  via: 'access' | 'token' | 'dev';
}

/** Typed error mapped to the JSON envelope by the router boundary. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
