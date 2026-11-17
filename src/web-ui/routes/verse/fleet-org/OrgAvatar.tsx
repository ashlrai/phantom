import { useState } from 'react';
import type { OrgMember } from './org-roster.js';
import styles from './fleet-org.module.css';

/**
 * The member's picture when it has one and it loads; the initials otherwise.
 * The shape and colour are closed tokens from the roster adapter, mapped to
 * design tokens in the stylesheet, so a preference can never inject CSS.
 */
export function OrgAvatar({ avatar, label }: { avatar: OrgMember['avatar']; label: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const showImage = avatar.imageSrc !== null && failed !== avatar.imageSrc;
  return <span className={styles.avatar} data-color={avatar.color} data-shape={avatar.shape} role="img" aria-label={`${label} avatar`}>
    {showImage
      ? <img src={avatar.imageSrc!} alt="" draggable={false} onError={() => setFailed(avatar.imageSrc)} />
      : <span aria-hidden="true">{avatar.initials}</span>}
  </span>;
}
