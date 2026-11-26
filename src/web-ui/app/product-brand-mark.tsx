import { PRODUCT_LOGO } from './product-brand.js';

export function PhantomMark({ size = 20 }: { size?: number }) {
  return <img src={PRODUCT_LOGO} width={size} height={size} alt="" data-phantom-mark="" style={{ verticalAlign: 'middle' }} />;
}
