import type { PlatformCapabilitySnapshotDto } from '@/api/types'

export function CapabilityReportView({ report }: { report: PlatformCapabilitySnapshotDto }) {
  return (
    <section aria-labelledby="capability-report-heading">
      <h3 id="capability-report-heading">Platform capability report</h3>
      <p className="maia-mono">
        {report.platform} · {report.adapter_version} · {report.overall_verdict.replace('_', ' ')}
      </p>
      {report.kernel_version ? (
        <p className="maia-mono">
          kernel {report.kernel_version}
          {report.landlock_abi != null ? ` · Landlock ABI ${report.landlock_abi}` : null}
        </p>
      ) : null}
      <table className="maia-table" data-testid="capability-report-table">
        <thead>
          <tr>
            <th scope="col">Probe</th>
            <th scope="col">Status</th>
            <th scope="col">Reason</th>
          </tr>
        </thead>
        <tbody>
          {report.probes.map((probe) => (
            <tr key={probe.name}>
              <td className="maia-mono">{probe.name}</td>
              <td>{probe.passed ? 'Ready' : 'Needs human'}</td>
              <td>{probe.safe_reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
