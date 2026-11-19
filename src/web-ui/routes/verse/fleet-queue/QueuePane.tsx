/** The dock Queue pane: the depth chart on top, then the queue itself (counts, launch order, lanes, parked groups, skips). */
import { requestLaneFocus } from '../fleet-lanes/lane-focus-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';
import { QueueDepthChart } from './QueueDepthChart.js';

export function QueuePane(props: PaneProps) {
  const openLane = (lane: string) => { requestLaneFocus(lane); props.host.openPane('fleet-lanes'); };
  return <>
    <QueueDepthChart visible={props.visible} onOpenLane={openLane} />
    <FleetQueuePane {...props} />
  </>;
}
