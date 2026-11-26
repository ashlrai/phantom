import { useEffect, useState } from 'react';
import { ECOSYSTEM_BRANDS } from '../../../core/brand/ecosystem.js';
import { PhantomMark } from '../../app/product-brand-mark.js';
import { useAppearance } from '../../data/appearance-hooks.js';
import { readSidebarBrand } from '../../data/sidebar-brand.js';

export function SidebarBrandMark({ size = 36 }: { size?: number }) {
  const { appearance } = useAppearance();
  const [upload, setUpload] = useState<{ id: string; src: string } | null>(null);
  const id = appearance.brandAsset;

  useEffect(() => {
    if (!id) return;
    const controller = new AbortController();
    void readSidebarBrand(controller.signal).then((src) => {
      if (src && !controller.signal.aborted) setUpload({ id, src });
    });
    return () => controller.abort();
  }, [id]);

  const src = appearance.brand === 'ghost'
    ? `${import.meta.env.BASE_URL}logos/${ECOSYSTEM_BRANDS['phantom-secrets'].logo}`
    : id && upload?.id === id ? upload.src : null;
  return src
    ? <img src={src} alt="" width={size} height={size} data-phantom-mark="" style={{ objectFit: 'contain', verticalAlign: 'middle' }} />
    : <PhantomMark size={size} />;
}
