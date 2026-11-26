import type { ecosystemBrand } from '../../../core/brand/ecosystem.js';
import styles from './EcosystemMark.module.css';

export function EcosystemMark({ brand, size = 20 }: { brand: ReturnType<typeof ecosystemBrand>; size?: number }) {
  if (!brand) return null;
  return <img className={styles.mark} data-tile={brand.tile} alt="" width={size} height={size} src={`${import.meta.env.BASE_URL}logos/${brand.logo}`} />;
}
