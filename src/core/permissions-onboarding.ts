/** Display-only permission evidence. It never grants authority or persists consent. */
export type PermissionStatus = 'granted' | 'missing' | 'unknown';
export interface PermissionObservation { status: PermissionStatus; reason: string }
export interface PermissionObservations {
  accessibility?: boolean | null;
  screen?: boolean | null;
  automationMessages?: PermissionObservation;
  automationSystemEvents?: PermissionObservation;
  fullDiskAccess?: PermissionObservation;
  developerTools?: PermissionObservation;
}

const pane = 'x-apple.systempreferences:com.apple.preference.security?Privacy_';
export const PERMISSION_DESCRIPTORS = [
  { id: 'accessibility', label: 'Accessibility', detail: 'Read and control the apps you explicitly allow.', settingsUrl: `${pane}Accessibility`, checkApi: 'AXIsProcessTrusted' },
  { id: 'screen', label: 'Screen Recording', detail: 'See app windows during approved computer use.', settingsUrl: `${pane}ScreenCapture`, checkApi: 'CGPreflightScreenCaptureAccess' },
  { id: 'automation-messages', label: 'Automation: Messages', detail: 'Allow approved Messages automation.', settingsUrl: `${pane}Automation`, checkApi: 'AEDeterminePermissionToAutomateTarget (askUserIfNeeded=false)' },
  { id: 'automation-system-events', label: 'Automation: System Events', detail: 'Allow approved System Events automation.', settingsUrl: `${pane}Automation`, checkApi: 'AEDeterminePermissionToAutomateTarget (askUserIfNeeded=false)' },
  { id: 'full-disk-access', label: 'Full Disk Access', detail: 'Review protected-file access for the app or terminal you use.', settingsUrl: `${pane}AllFiles`, checkApi: null },
  { id: 'developer-tools', label: 'Developer Tools', detail: 'Review permission for the development tools you use.', settingsUrl: `${pane}DevTools`, checkApi: null },
] as const;
export type PermissionId = typeof PERMISSION_DESCRIPTORS[number]['id'];
export type PermissionRow = typeof PERMISSION_DESCRIPTORS[number] & PermissionObservation;

/** Missing evidence stays unknown. A settings visit is never evidence of a grant. */
export function buildPermissionRows(observed: unknown = {}, platform = 'darwin'): PermissionRow[] {
  const data = observed && typeof observed === 'object' && !Array.isArray(observed) ? observed as Record<string, unknown> : {};
  const boolean = (value: unknown): PermissionObservation => ({
    status: value === true ? 'granted' : value === false ? 'missing' : 'unknown',
    reason: typeof value === 'boolean' ? 'macOS reports this permission for the checked process.' : 'Permission status could not be checked.',
  });
  const manual = { status: 'unknown' as const, reason: 'Phantom cannot verify this permission. Review it manually in System Settings.' };
  const automation = (value: unknown): PermissionObservation => {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return {
      status: row.status === 'granted' || row.status === 'missing' ? row.status : 'unknown',
      reason: row.status === 'granted' ? 'macOS reports Automation access for the checked process.'
        : row.status === 'missing' ? 'Automation is denied or still requires your consent.'
        : row.reason === 'automation-unavailable-in-build' ? 'This app build cannot request Automation access. Review the permission manually in System Settings.'
        : row.reason === 'automation-target-not-running' ? 'Open the named app yourself, then check permissions again. Its Automation permission is still unknown.'
        : 'Automation access could not be checked. Review the permission manually in System Settings.',
    };
  };
  const evidence: Record<PermissionId, PermissionObservation> = {
    accessibility: boolean(data.accessibility),
    screen: boolean(data.screen),
    'automation-messages': automation(data.automationMessages),
    'automation-system-events': automation(data.automationSystemEvents),
    // Never turn a UI acknowledgement or untrusted native field into a grant.
    'full-disk-access': manual,
    'developer-tools': manual,
  };
  return PERMISSION_DESCRIPTORS.map((row) => ({ ...row, ...(platform === 'darwin' ? evidence[row.id] : {
    status: 'unknown' as const, reason: 'These permissions apply to macOS. This host was not probed.',
  }) }));
}
