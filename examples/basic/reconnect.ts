import { StuDevice } from 'stusign';
import type { WebHidManager } from 'stusign/webhid';

/** Only use this policy when one previously authorized HID tablet is expected. */
export function watchAuthorizedTablet(
  manager: WebHidManager,
  connected: (tablet: StuDevice) => void,
  reportError: (error: unknown) => void,
): () => Promise<void> {
  let tablet: StuDevice | undefined;
  let stopped = false;
  let queue = Promise.resolve();
  const abort = new AbortController();

  const schedule = (readyStabilityMs: number): void => {
    queue = queue
      .then(async () => {
        if (stopped || tablet?.state === 'open') return;
        await tablet?.close();
        tablet = undefined;
        const handles = await manager.getAuthorizedDevices();
        if (stopped || handles.length !== 1) return; // Use a click-driven chooser otherwise.
        const opened = await StuDevice.open(handles[0]!, {
          readyStabilityMs,
          signal: abort.signal,
        });
        if (stopped) await opened.close();
        else {
          tablet = opened;
          connected(opened);
        }
      })
      .catch((error: unknown) => {
        if (!stopped) reportError(error);
      });
  };

  const unsubscribe = manager.onConnection((event) => {
    if (event.connected) schedule(1500);
  });
  schedule(0); // Page refresh: check readiness immediately.

  return async () => {
    stopped = true;
    unsubscribe();
    abort.abort();
    await queue;
    await tablet?.close();
    tablet = undefined;
  };
}
