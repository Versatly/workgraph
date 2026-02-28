import { formatDurationHours } from './format.js';
import type { DoctorReport } from './doctor.js';
import type { VaultStats } from './stats.js';

export function renderDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  lines.push(`Vault health: ${report.ok ? 'OK' : 'NOT OK'}`);
  lines.push(`Errors: ${report.summary.errors}  Warnings: ${report.summary.warnings}`);
  lines.push(
    `Checks: orphan_links=${report.checks.orphanWikiLinks} stale_claims=${report.checks.staleClaims} stale_runs=${report.checks.staleRuns} missing_required=${report.checks.missingRequiredFields} broken_registry_refs=${report.checks.brokenPrimitiveRegistryReferences} empty_dirs=${report.checks.emptyPrimitiveDirectories} duplicate_slugs=${report.checks.duplicateSlugs}`,
  );

  if (report.fixes.enabled) {
    lines.push(
      `Auto-fix: removed_orphan_links=${report.fixes.orphanLinksRemoved} released_stale_claims=${report.fixes.staleClaimsReleased} cancelled_stale_runs=${report.fixes.staleRunsCancelled}`,
    );
    if (report.fixes.filesUpdated.length > 0) {
      lines.push(`Updated files: ${report.fixes.filesUpdated.join(', ')}`);
    }
    if (report.fixes.errors.length > 0) {
      lines.push(`Fix errors: ${report.fixes.errors.length}`);
      for (const error of report.fixes.errors) {
        lines.push(`  - ${error}`);
      }
    }
  }

  if (report.issues.length === 0) {
    lines.push('No issues detected.');
    return lines;
  }

  lines.push('Issues:');
  for (const issue of report.issues) {
    const pathSuffix = issue.path ? ` (${issue.path})` : '';
    lines.push(`- [${issue.severity.toUpperCase()}] ${issue.code}${pathSuffix}: ${issue.message}`);
  }
  return lines;
}

export function renderStatsReport(stats: VaultStats): string[] {
  const lines: string[] = [];
  lines.push(`Primitives: total=${stats.primitives.total}`);
  lines.push(
    `By type: ${Object.entries(stats.primitives.byType).map(([type, count]) => `${type}=${count}`).join(', ') || 'none'}`,
  );
  lines.push(
    `Links: total=${stats.links.total} density=${stats.links.wikiLinkDensity.toFixed(2)} orphan_links=${stats.links.orphanCount} orphan_nodes=${stats.links.orphanNodeCount}`,
  );
  lines.push(
    `Top hubs: ${stats.links.mostConnectedNodes.slice(0, 5).map((hub) => `${hub.path}(${hub.degree})`).join(', ') || 'none'}`,
  );
  lines.push(
    `Frontmatter completeness: avg=${(stats.frontmatter.averageCompleteness * 100).toFixed(1)}%`,
  );
  lines.push(
    `Ledger event rate/day: avg=${stats.ledger.eventRatePerDay.average.toFixed(2)} over ${stats.ledger.eventRatePerDay.byDay.length} day(s)`,
  );
  lines.push(
    `Thread velocity: completed=${stats.threads.completedCount} avg_open_to_done=${formatDurationHours(stats.threads.averageOpenToDoneHours)}`,
  );
  return lines;
}
