import { useId } from 'react';
import styles from './CoffeeAwakeScene.module.css';

/** Decorative feedback, never a power-source or sleep-assertion measurement. */
export function CoffeeAwakeScene({ active, pouring, onPourEnd }: {
  active: boolean;
  pouring: boolean;
  onPourEnd: () => void;
}) {
  const cupClip = useId();
  return (
    <svg viewBox="0 0 160 100" className={styles.scene} aria-hidden="true" focusable="false"
      data-active={active} data-pouring={pouring}>
      <defs><clipPath id={cupClip}><path d="M66 60h48l-4 24c-1 6-8 9-20 9s-19-3-20-9Z" /></clipPath></defs>
      <path className={styles.ground} d="M55 95h76" />
      <g className={styles.pot} onAnimationEnd={onPourEnd}>
        <path className={styles.vessel} d="M17 23h34l6 34c1 9-5 15-22 15S11 66 13 57Z" />
        <path className={styles.outline} d="M17 23h34l6 34c1 9-5 15-22 15S11 66 13 57Z M50 28l14 2-9 13 M17 29C1 27 1 51 13 53" />
        <path className={styles.lid} d="M15 22h38M29 18h12" />
        <path className={styles.potCoffee} d="M16 47h38l2 11c1 8-6 11-21 11s-22-4-20-11Z" />
      </g>
      <path className={styles.stream} d="M65 39Q87 42 88 65" />
      <path className={styles.vessel} d="M66 60h48l-4 24c-1 6-8 9-20 9s-19-3-20-9Z" />
      <g clipPath={`url(#${cupClip})`}><path className={styles.coffee} d="M63 70Q76 67 89 70T117 70v27H63Z" /></g>
      <path className={styles.outline} d="M66 60h48l-4 24c-1 6-8 9-20 9s-19-3-20-9Z M114 65h5c15 0 12 18-8 18" />
      <g className={styles.steam}><path d="M80 54q-6-5 0-10t0-10M94 54q-6-5 0-10t0-10" /></g>
    </svg>
  );
}
