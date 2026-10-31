import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { closeInterjectDialog, useInterjectDialogOpen } from '../fleet/interject-dialog-store.js';
import { findCommand } from './command-catalog.js';
import { resetCommandBus } from './command-bus.js';
import { executeCatalogCommand, registerShellCommandHandlers } from './run-command.js';

afterEach(() => { act(closeInterjectDialog); resetCommandBus(); });

describe('fleet interject command', () => {
  it('opens the global dialog from the palette', async () => {
    expect(findCommand('fleet.interject')).toMatchObject({ group: 'actions', scope: 'global' });
    registerShellCommandHandlers();
    const { result } = renderHook(useInterjectDialogOpen);
    expect(executeCatalogCommand('fleet.interject', { via: 'palette' })).toBe(true);
    await waitFor(() => expect(result.current).toBe(true));
  });
});
