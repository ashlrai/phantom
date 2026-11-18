# Owner note draft composer

`OwnerInterjectionDraft` is a separate, **unmounted local-only component** under
`src/web-ui/components/agent-chat`. It prepares an explicit `agent-chat.share`
JSON object; it does not send a message, create an owner receipt, or establish
human identity. Mounting belongs to the agent-chat pane owner after that pane's
change lands. No Fleet/resources or session composer files are modified.

The parent must supply an explicitly selected `channel` and `thread` (`run:<id>`
or `outcome:<id>`). Do not infer either from prose. Scope changes reset the draft.
Do not prefill private history. Drafts exist only in component memory and vanish
on unmount; neither storage nor network is used. Text renders as React text.

The user can review the exact JSON and click **Copy draft JSON**. The component
uses the browser-safe shared secret detector on decoded fields and final JSON,
and limits the complete JSON to the native receiver's 6,000-character cap.
Clipboard denial is an error, never a success or send receipt. Edits invalidate
the copied indicator; late clipboard results cannot update another scope.

Native owner-share availability remains explicitly unverified. After the fleet
qualifies that ingress, the user may send the prepared JSON once through their
already verified iMessage account. Do not add a loopback self-send, shared-token
POST, `isTrusted` check, or fabricated owner flag as a substitute. Native account
namespace/GUID and durable receipt state establish sharing, not copying.
Copying twice does not send twice; sending two distinct iMessages creates two
native events. No client-generated extra idempotency field is added because the
native strict request schema does not accept one.

Validation covers local behavior and bounds. Installed desktop rendering,
clipboard permission behavior, pane mounting, and live native delivery still
require qualification. This component is not a desktop owner-send capability.
