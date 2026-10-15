/** A current draft recommendation, never a send or result receipt. No actions or IO. */
import type { AutomaticDecisionReceiptV1, AutomaticRecommendedBinding } from '../../../../core/routing/automatic-decision-types.js';
import styles from './multimodel.module.css';

function Binding({ binding }: { binding: AutomaticRecommendedBinding }) {
  return <span>{binding.model ?? 'Unknown model'} · {binding.contextMode ?? 'Unknown context mode'} · {binding.contextWindow === null ? 'Unknown context window' : `${binding.contextWindow.toLocaleString('en-US')} tokens context`}</span>;
}

export function AutomaticAdviceDetails({ receipt, accountLabels }: {
  receipt: AutomaticDecisionReceiptV1;
  accountLabels: Readonly<Record<string, string>>;
}) {
  const cls = receipt.classification;
  const accountLabel = (binding: AutomaticRecommendedBinding) => {
    const label = binding.seatId !== null && Object.hasOwn(accountLabels, binding.seatId) ? accountLabels[binding.seatId] : null;
    return typeof label === 'string' ? label : 'Unknown account';
  };
  return (
    <details className={styles.automaticDetails}>
      <summary>Automatic details</summary>
      <div className={styles.automaticBody}>
        <p>Draft recommendation · may change when you send.</p>
        {receipt.recommendedBinding ? <dl>
          <dt>Resource</dt><dd>{accountLabel(receipt.recommendedBinding)}</dd>
          <dt>Model and context</dt><dd><Binding binding={receipt.recommendedBinding} /></dd>
        </dl> : <p>No recommendation is available for this draft.</p>}
        <dl>
          <dt>Task</dt><dd>{cls.task ?? 'Unknown'}{cls.kind !== null && cls.kind !== cls.task ? ` (${cls.kind})` : ''} · {cls.difficulty === null ? 'Unknown difficulty' : `${cls.difficulty} difficulty`}</dd>
          <dt>Read by</dt><dd>{cls.decidedBy === 'rules' ? 'Rules' : cls.decidedBy === 'jev' ? 'Jev' : 'Unknown'}</dd>
        </dl>
        {receipt.baseline.localOnly ? <p>Local-only project.</p> : null}
        {receipt.alternatives.length > 0 ? <>
          <p>Other recommendations, in advice order:</p>
          <ol>{receipt.alternatives.map((binding, index) => <li key={index}>{accountLabel(binding)} · <Binding binding={binding} /></li>)}</ol>
        </> : null}
        <p>Actual model use, results, quality, time and cost are unknown in this preview.</p>
      </div>
    </details>
  );
}
