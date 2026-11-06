/** Imports for dialogs opened by an explicit chat action, not first paint. */
export const loadNewChatDialog = () => import('../NewChatDialog.js').then((m) => m.NewChatDialog);
export const loadDevinStopDialog = () => import('../devin/DevinStopDialog.js').then((m) => m.DevinStopDialog);
