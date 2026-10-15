# Keyboard hints

Use keyboard hints to navigate the Phantom workbench or focus the chat composer
without moving the pointer. This optional experimental feature starts disabled.

## Enable and use hints

1. Open the workbench's gear menu.
2. Enable **Phantom keyboard hints (experimental)**.
3. Choose **Ctrl+Alt+H** or **Ctrl+Shift+H** in the same menu.
4. Close the menu, then press your chosen shortcut while Phantom has focus.
5. Type the letters on a visible label to activate its registered navigation
   control or focus its input. Press **Escape** to cancel.

Focusing the composer preserves its draft. Hint selection does not submit it.
Ordinary typing continues when hints are idle. The preference is saved in this
browser's local storage; another browser or device has its own preference.
Disable the feature in the gear menu to stop entering new hint sessions.

## Supported controls and limits

Hints cover registered workbench navigation, known shell controls, and the chat
composer. They pause while a dialog, menu, or approval overlay owns input.
Password and secure inputs, disabled controls, and partially clipped controls
are excluded. Reveal a clipped control with ordinary navigation before using
hints.

A session cancels when focus, its control identities, the active workspace, or
its layout changes. If labels cannot fit distinctly in the viewport, use the
ordinary keyboard shortcuts or pointer. Discovery is bounded to 200 controls.
Unregistered actions, form submission, and destructive approval controls are
outside hint navigation.

This workbench feature uses the focused app page. Global macOS accessibility
overlays and their separate native helper remain a separate prototype and are
not installed by enabling this preference.

See the [Phantom user guide](VERSE.md) for the workbench's standard keyboard
shortcuts and navigation.
