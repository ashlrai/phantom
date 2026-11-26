import { ECOSYSTEM_BRANDS } from '../../core/brand/ecosystem.js';

/** Here, not in product-brand.ts: the entry imports that file, and the brand table is not first-paint code. */
export const PRODUCT_LOGO = `${import.meta.env.BASE_URL}logos/${ECOSYSTEM_BRANDS.phantom.logo}`;

export function PhantomMark({ size = 20 }: { size?: number }) {
  return <img src={PRODUCT_LOGO} width={size} height={size} alt="" data-phantom-mark="" style={{ verticalAlign: 'middle' }} />;
}
