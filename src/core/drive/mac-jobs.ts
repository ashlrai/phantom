/** Restockable local Mac job definition, with no shell, model or transport. */
export function driveMacJobs(bin: string, root: string): { label: string; plist: string }[] {
  const entities: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' };
  const xml = (value: string): string => value.replace(/[<>&"']/g, c => entities[c]!);
  return [{
    label: 'ai.ashlr.drive-routines',
    plist: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>ai.ashlr.drive-routines</string>
<key>ProgramArguments</key><array><string>${xml(bin)}</string><string>drive</string><string>report</string><string>--once</string><string>--root</string><string>${xml(root)}</string></array>
<key>StartInterval</key><integer>300</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
</dict></plist>`,
  }];
}
