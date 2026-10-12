# Phantom UI design principles

These rules apply to every Phantom screen, especially setup and onboarding.
Future contributors, human or agent, should follow them.

1. **One primary action per screen (Hick's law).** Each screen has exactly one
   prominent button. Every other control uses the `ghost` or `subtle` style. Tests
   should assert this, as `SetupWizard.test.tsx` does.
2. **Use smart defaults so most people just press Continue.** Turn
   recommended options on and pre-fill what Phantom can detect: seats, CLIs on
   PATH and installed companions. Never make users type something we already know.
3. **Keep clicks to a minimum.** Fold optional work into a disclosure instead of
   adding a screen.
4. **Disclose progressively.** Show a title and one plain line first. Details,
   commands and explanations sit behind a click (`<details>` or a card that expands).
5. **Write in plain language.** Use short sentences, explain any jargon in passing,
   and avoid walls of caveats. Say what happens, not how it's built.
6. **Show progress clearly.** Display the step count (`2 / 5`) and a progress bar,
   and expose `aria-current="step"` to assistive technology.
7. **Keep Skip and Back available.** No screen should trap the user. Esc closes,
   and skipping never loses saved answers.
8. **Design keyboard-first.** Enter continues when focus isn't on a control,
   Alt+← and Alt+→ move between steps, focus is trapped inside dialogs, and every
   control has an accessible name.
9. **Never rely on colour alone.** Pair each tone with a glyph or a word, as in DESIGN-V2 §6.
10. **Never assert more than you read, and never handle secrets.** A missing
    reading shows as "not reported", not as a pass. UI fields accept names and
    references, never secret values. Anything sent to a model is redacted.
11. **Never automate a user's public act.** Starring, posting and installing
    always need the user's own click or command.

The audience is agentic engineers and teams. Respect their time, show the
command behind each action, and make the default path fast.
