export interface ProjectionTimeRange {
  from?: string;
  to?: string;
}

export interface ProjectionFilters {
  status?: string[];
  owner?: string[];
  tags?: string[];
  space?: string;
}

export interface ProjectionQuery {
  scope: 'thread' | 'mission' | 'org' | 'run' | 'transport' | 'federation' | 'trigger' | 'autonomy';
  timeRange?: ProjectionTimeRange;
  filters?: ProjectionFilters;
}

export interface ProjectionSummary {
  healthy: boolean;
  generatedAt: string;
  scope: ProjectionQuery['scope'];
}
