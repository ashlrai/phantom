import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SECTION_ICON } from './verse-icons.js';
import { VERSE_SECTIONS } from './verse-ui-store.js';

describe('section icons', () => {
  it.each(VERSE_SECTIONS)('renders $id as a decorative icon beside its section label', ({ id, label }) => {
    const SectionIcon = SECTION_ICON[id];
    const { container, getByRole } = render(<button><SectionIcon />{label}</button>);
    expect(getByRole('button', { name: label })).toBeInTheDocument();
    const icon = container.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('focusable', 'false');
    expect(icon).toHaveAttribute('viewBox', '0 0 16 16');
    expect(icon?.children.length).toBeGreaterThan(0);
  });
});
