export interface GateCheckInput {
  actor: string;
  primitiveType: string;
  fromStatus?: string;
  toStatus?: string;
}

export interface GateCheckDecision {
  allowed: boolean;
  reason?: string;
}
