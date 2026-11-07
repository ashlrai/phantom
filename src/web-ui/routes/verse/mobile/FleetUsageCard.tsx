import { readFailureReason } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { apiSpendLine, asOfText, ledgerRows, runsOutText, sourceLabel } from '../usage/fleet-ledger-model.js';
import { fleetLedgerQuery } from '../usage/fleet-ledger-queries.js';
import { ErrorState, Row, Section } from './ui-parts.js';
import { SkeletonList } from './ui.js';

export function FleetUsageCard() {
  const query = useQuery(fleetLedgerQuery);
  const refetch = useRefetch(fleetLedgerQuery);
  usePollWhileVisible(refetch, 60_000);

  const data = query.data;
  const now = Date.now();
  const footer = data ? (
    <>
      {asOfText(data, now)}
      {query.status === 'error' ? ' · refresh failed' : null}
      {data.apiSpend ? <><br />{apiSpendLine(data.apiSpend)}</> : null}
    </>
  ) : undefined;

  return (
    <Section title="Usage" footer={footer}>
      {data ? ledgerRows(data, now).map((row, index) => (
        <Row
          key={`${row.lane}-${index}`}
          title={row.lane}
          subtitle={runsOutText(data.lanes[index]!, now) ?? `source: ${sourceLabel(row.source)}`}
          trailing={row.usage}
        />
      )) : query.status === 'idle' || query.status === 'loading' ? (
        <SkeletonList rows={2} label="Loading usage" />
      ) : data === null ? (
        <Row title="Ledger not readable from this Mac yet" />
      ) : (
        <ErrorState title="Couldn’t read usage" reason={readFailureReason(query.error)} onRetry={refetch} />
      )}
    </Section>
  );
}
