import { encodeQr } from './qr-encode.js';
import styles from './qr.module.css';

export function QrSvg({ value, size = 192, label = 'QR code' }: { value: string; size?: number; label?: string }) {
  const qr = encodeQr(value);
  const path = qr.modules.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4} ${y + 4}h1v1h-1z`] : [])).join('');
  return <svg className={styles.tile} width={size} height={size} viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`} role="img" aria-label={label} shapeRendering="crispEdges"><path fill="currentColor" d={path} /></svg>;
}
