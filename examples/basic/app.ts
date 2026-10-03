import { StuDevice, type Recording, type Signature } from 'stusign';
import { createWebHidManager } from 'stusign/webhid';
import { createWebSerialManager } from 'stusign/webserial';
import { createObjectURL, toSVGBlob } from 'stusign/render';

const connect = document.querySelector<HTMLButtonElement>('#connect')!;
const finish = document.querySelector<HTMLButtonElement>('#finish')!;
const cancel = document.querySelector<HTMLButtonElement>('#cancel')!;
const serial = document.querySelector<HTMLInputElement>('#serial')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const preview = document.querySelector<HTMLImageElement>('#preview')!;
const download = document.querySelector<HTMLAnchorElement>('#download')!;
let imageURL: ReturnType<typeof createObjectURL> | undefined;

function review(tablet: StuDevice): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const settle = (accepted?: boolean, error?: unknown): void => {
      finish.disabled = cancel.disabled = true;
      finish.onclick = cancel.onclick = null;
      unsubscribe();
      if (error) reject(error);
      else resolve(accepted ?? false);
    };
    const unsubscribe = tablet.on((event) => {
      if (event.type === 'disconnect')
        settle(
          false,
          event.reason instanceof Error ? event.reason : new Error('Tablet disconnected'),
        );
      if (event.type === 'error') settle(false, event.error);
    });
    finish.onclick = () => settle(true);
    cancel.onclick = () => settle(false);
    finish.disabled = cancel.disabled = false;
  });
}

function showSignature(signature: Signature): void {
  imageURL?.dispose();
  imageURL = createObjectURL(toSVGBlob(signature, { background: '#ffffff' }));
  preview.src = download.href = imageURL.url;
  download.hidden = false;
  status.textContent = signature.complete ? 'Signature ready.' : 'Signature contains input gaps.';
}

connect.addEventListener('click', async () => {
  connect.disabled = true;
  imageURL?.dispose();
  imageURL = undefined;
  preview.removeAttribute('src');
  download.removeAttribute('href');
  download.hidden = true;
  let tablet: StuDevice | undefined;
  let recording: Recording | undefined;
  try {
    const manager = serial.checked
      ? createWebSerialManager({ baudRate: 128000 })
      : createWebHidManager();
    // Keep this call in the click handler: the browser requires a user gesture.
    const transport = await manager.requestDevice();
    if (!transport) {
      status.textContent = 'Selection cancelled.';
      return;
    }
    tablet = await StuDevice.open(transport);
    await tablet.display.clear();
    await tablet.settings.setInking(true);
    // Deliberate plaintext example. See the encryption section for required protection.
    recording = tablet.capture.create({ encryption: 'none' });
    await recording.start();
    status.textContent = 'Sign on the tablet, then choose Finish or Cancel.';
    if (await review(tablet)) {
      const signature = await recording.finish();
      if (signature.hasInk) showSignature(signature);
      else status.textContent = 'No ink captured.';
    } else {
      await recording.cancel();
      status.textContent = 'Cancelled.';
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Capture failed.';
  } finally {
    try {
      await recording?.dispose();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Capture cleanup failed.';
    }
    try {
      await tablet?.close();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : 'Connection cleanup failed.';
    }
    connect.disabled = false;
  }
});

window.addEventListener('pagehide', () => imageURL?.dispose());
