export interface PolicyParty {
  id: string;
  roles: string[];
  capabilities: string[];
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRegistry {
  version: number;
  parties: Record<string, PolicyParty>;
}
