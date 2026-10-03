import { StuDevice, StuError } from 'stusign';
import type { Signature, Recording, PenSample, ReportTransport } from 'stusign';
import { createWebHidManager, WebHidTransport } from 'stusign/webhid';
import { createWebSerialManager, WebSerialTransport } from 'stusign/webserial';
import type { SerialPortInfo } from 'stusign/webserial';
import { createRsaCryptoProvider } from 'stusign/crypto';
import { ReportId } from 'stusign/protocol';
import type { ImageFormat, RgbaImage } from 'stusign/protocol';
import { createObjectURL, drawSignature, toPNGBlob, toSVGBlob } from 'stusign/render';
import { MockTransport, penFixture } from 'stusign/testing';
import { ReviewGate, verdict } from './review.js';
import type { Confirmation, TechnicalResult, Verdict } from './review.js';
import { pattern, whiteImage, overlay } from './patterns.js';
import { WelcomePanel } from './welcome.js';
import {
  applyBackground,
  applyBootScreen,
  backgroundRgb,
  solidImage,
  BackgroundPreference,
} from './appearance.js';
import { AutoReconnect } from './reconnect.js';
import type { ReconnectReason } from './reconnect.js';

type Result = {
  check: string;
  source: 'hardware' | 'simulation' | 'software';
  expected: readonly string[];
  technical: TechnicalResult;
  confirmation?: Confirmation;
  result: Verdict;
  details: string;
  observation: string;
  durationMs: number;
};
const results: Result[] = [];
const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const status = element<HTMLOutputElement>('status');
const progress = element<HTMLProgressElement>('progress');
const canvas = element<HTMLCanvasElement>('preview');
const context = canvas.getContext('2d')!;
const penCanvas = element<HTMLCanvasElement>('pen-preview');
const penContext = penCanvas.getContext('2d')!;
const review = new ReviewGate<Confirmation>();
const drawing = new ReviewGate<void>();
const simulated = new URLSearchParams(location.search).get('simulate') === '1';
let tablet: StuDevice | undefined;
let handle: ReportTransport | undefined;
let recording: Recording | undefined;
let signature: Signature | undefined;
let previous: PenSample | undefined;
let controller: AbortController | undefined;
let liveInk = false;
let drawOnTabletPreview = false;
let inputFailure: Error | undefined;
let evidence: Record<string, unknown> = {};
let busy = false;
let currentResult: Result | undefined;
let reconnect: AutoReconnect | undefined;
let reconnectReady = false;
let pageClosed = false;
let unsubscribeConnections: (() => void) | undefined;
let hidManager: ReturnType<typeof createWebHidManager> | undefined;
let serialManager: ReturnType<typeof createWebSerialManager> | undefined;
type ConnectionMode = 'hid' | 'serial-usb' | 'serial-rs232';
let connectionMode: ConnectionMode = 'hid';
let selectedSerialInfo: SerialPortInfo | undefined;
const connectionKey = 'stusign.connection.v1';
const serialSelectionKey = 'stusign.serial.selection.v1';
let simulatedAttached = true;
let simulatedAuthorized = false;
let virtualTablet: MockTransport | undefined;
let simulatedBootAt: number | undefined;
const reconnectKey = `stusign.reconnect.v1.${simulated ? 'simulation' : 'hardware'}`;
const simulatedPermissionKey = 'stusign.simulation.authorized.v1';
const backgroundPreference = new BackgroundPreference(
  `stusign.background.v1.${simulated ? 'simulation' : 'hardware'}`,
  {
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  },
);
const welcome = new WelcomePanel(simulated, () => setBusy(busy));
const tabletActions = new Set([
  'display',
  'partial',
  'settings',
  'capture',
  'encrypted',
  'baseline',
  'rom',
  'cycles',
  'disconnect',
  'welcome-show',
  'welcome-store',
  'welcome-recall',
  'appearance-read',
  'boot-apply',
  'background-apply',
]);
class RestoreError extends Error {}

function failure(error: unknown): string {
  if (error instanceof StuError) {
    const metadata = [
      error.operation,
      error.reportId === undefined
        ? undefined
        : `report 0x${error.reportId.toString(16).padStart(2, '0')}`,
      error.status === undefined
        ? undefined
        : `status 0x${error.status.toString(16).padStart(2, '0')}`,
      error.cause instanceof DOMException ? error.cause.name : undefined,
    ].filter(Boolean);
    return `${error.code}: ${error.message}${metadata.length ? ` (${metadata.join('; ')})` : ''}`;
  }
  return error instanceof Error ? error.message : 'Unknown failure';
}
function signal(): AbortSignal {
  if (!controller) throw new Error('No active test');
  controller.signal.throwIfAborted();
  return controller.signal;
}
function connected(): StuDevice {
  if (!tablet || tablet.state !== 'open') throw new Error('Connect the tablet first.');
  return tablet;
}
function renderResults(): void {
  element('results').replaceChildren();
  for (const result of results) {
    const row = document.createElement('tr');
    for (const text of [
      result.check,
      result.result,
      result.confirmation ?? 'Waiting',
      [result.details, result.observation].filter(Boolean).join(' — '),
    ]) {
      const cell = document.createElement('td');
      cell.textContent = text;
      row.append(cell);
    }
    row.children[1]!.className = result.result;
    element('results').append(row);
  }
}
function instructions(items: readonly string[]): void {
  element('instructions').replaceChildren(
    ...items.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }),
  );
}
function showExpected(image: RgbaImage, caption: string): void {
  element('expected').hidden = false;
  canvas.width = image.width;
  canvas.height = image.height;
  context.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
  element('preview-caption').textContent = caption;
}
function setBusy(value: boolean): void {
  busy = value;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-operation]')) {
    button.disabled =
      value ||
      welcome.loading ||
      (simulated && button.id === 'encrypted') ||
      (tabletActions.has(button.id) && tablet?.state !== 'open') ||
      (button.id === 'connect' && tablet?.state === 'open');
  }
  element<HTMLButtonElement>('cancel').disabled = !value;
  welcome.setDisabled(value);
  for (const input of document.querySelectorAll<HTMLInputElement>('[data-tablet-option]'))
    input.disabled = value || welcome.loading || tablet?.state !== 'open';
  element<HTMLInputElement>('reconnect-auto').disabled = value || welcome.loading;
  element<HTMLInputElement>('background-auto').disabled = value || welcome.loading;
  element<HTMLSelectElement>('connection-mode').disabled =
    simulated || value || welcome.loading || tablet?.state === 'open';
  if (!value) void reconnect?.flush();
}
function hideDecisions(): void {
  element('review-actions').hidden = true;
  element('acknowledge').hidden = true;
  element('finish-drawing').hidden = true;
}
async function step(
  name: string,
  expected: readonly string[],
  work: () => Promise<string | void>,
  source: Result['source'] = simulated ? 'simulation' : 'hardware',
): Promise<boolean> {
  const activeSignal = signal();
  const result: Result = {
    check: name,
    source,
    expected,
    technical: 'running',
    result: 'pending',
    details: '',
    observation: '',
    durationMs: 0,
  };
  results.push(result);
  currentResult = result;
  renderResults();
  hideDecisions();
  element('expected').hidden = true;
  element('pen-panel').hidden = true;
  element('step-title').textContent = name;
  element('step-phase').textContent = 'Running';
  element('step-details').textContent = 'Sending the test to the tablet…';
  element<HTMLTextAreaElement>('step-notes').value = '';
  element('step-notes-field').hidden = true;
  instructions(expected);
  progress.value = 0;
  status.textContent = name;
  element('current-step').scrollIntoView({ behavior: 'smooth', block: 'start' });
  const started = performance.now();
  try {
    try {
      result.details = (await work()) ?? 'Device commands completed.';
      activeSignal.throwIfAborted();
      result.technical = 'passed';
    } catch (error) {
      if (activeSignal.aborted) throw error;
      result.technical =
        error instanceof StuError && error.code === 'UNSUPPORTED_FEATURE' ? 'skipped' : 'failed';
      result.details = failure(error);
    }
    result.durationMs = Math.round(performance.now() - started);
    result.result = verdict(result.technical);
    renderResults();
    element('step-details').textContent = result.details;
    element('step-notes-field').hidden = false;
    element('finish-drawing').hidden = true;
    const answer = review.wait(activeSignal);
    if (result.technical === 'passed') {
      element('step-phase').textContent = 'Your confirmation';
      element('review-actions').hidden = false;
      status.textContent = 'Check the instructions and tablet. Nothing advances until you answer.';
    } else {
      element('step-phase').textContent =
        result.technical === 'failed' ? 'Could not complete this step' : 'Not supported';
      element('acknowledge').hidden = false;
      status.textContent = 'Review the error, then continue or stop the test.';
    }
    result.confirmation = await answer;
    result.observation = element<HTMLTextAreaElement>('step-notes').value.trim();
    result.result = verdict(result.technical, result.confirmation);
    element('step-phase').textContent =
      result.result === 'passed' ? 'Confirmed by you' : result.result;
    return result.result === 'passed';
  } catch (error) {
    result.durationMs = Math.round(performance.now() - started);
    result.confirmation = 'cancelled';
    result.observation = element<HTMLTextAreaElement>('step-notes').value.trim();
    result.result = verdict(result.technical, result.confirmation);
    result.details = [result.details, failure(activeSignal.reason ?? error)]
      .filter(Boolean)
      .join(' ');
    element('step-details').textContent = result.details;
    element('step-phase').textContent = 'Stopped';
    throw error;
  } finally {
    hideDecisions();
    renderResults();
  }
}
element('step-notes').addEventListener('input', () => {
  if (currentResult)
    currentResult.observation = element<HTMLTextAreaElement>('step-notes').value.trim();
});
for (const [id, answer] of [
  ['matches', 'matches'],
  ['differs', 'differs'],
  ['not-checked', 'not-checked'],
  ['acknowledge', 'acknowledged'],
] as const) {
  element(id).addEventListener('click', () => {
    if (review.answer(answer)) hideDecisions();
  });
}
element('finish-drawing').addEventListener('click', () => {
  if (drawing.answer()) element('finish-drawing').hidden = true;
});
element('cancel').addEventListener('click', () => {
  reconnect?.cancelPending();
  controller?.abort(new DOMException('Test stopped by you.', 'AbortError'));
  hideDecisions();
  status.textContent = 'Stopping the test and restoring temporary settings…';
});
function button(id: string, work: () => Promise<void>): void {
  const target = element<HTMLButtonElement>(id);
  target.dataset.operation = '';
  target.addEventListener('click', () => {
    if (busy) return;
    reconnect?.cancelPending();
    void runOperation(target.textContent ?? id, work);
  });
}
function runOperation(name: string, work: () => Promise<void>): Promise<void> {
  if (busy) return Promise.resolve();
  setBusy(true);
  controller = new AbortController();
  // Invoke immediately to preserve a manual HID/serial chooser's user gesture.
  return work()
    .then(() => {
      status.textContent = 'Finished. Review the results below or choose another test.';
    })
    .catch((error) => {
      status.textContent = failure(error);
      if (!controller?.signal.aborted || error instanceof RestoreError) {
        results.push({
          check: name,
          source: simulated ? 'simulation' : 'hardware',
          expected: [],
          technical: 'failed',
          result: 'failed',
          details: failure(error),
          observation: '',
          durationMs: 0,
        });
        renderResults();
      }
    })
    .finally(() => {
      hideDecisions();
      liveInk = false;
      controller = undefined;
      setBusy(false);
    });
}
function updateEvidence(): void {
  element('device').textContent = JSON.stringify(evidence, null, 2);
}
async function open(selected: ReportTransport, reason?: ReconnectReason): Promise<void> {
  handle = selected;
  const startupImage = welcome.startup();
  const startupBackground = backgroundPreference.startupColor;
  // A page load usually finds an already running tablet. Keep the cold-boot
  // guard for USB events and manual connections, where power-on timing is unknown.
  const readyStabilityMs = reason === 'page load' ? 0 : 1500;
  element('step-details').textContent =
    readyStabilityMs === 0
      ? 'Checking tablet readiness, then restoring the saved display settings…'
      : 'Waiting for stable tablet readiness, then restoring the saved display settings…';
  const device = await StuDevice.open(handle, {
    cryptoProvider: createRsaCryptoProvider(),
    signal: signal(),
    readyStabilityMs,
    ...(selected.kind === 'webserial' && startupImage?.source === 'upload'
      ? { timeoutMs: 300_000 }
      : {}),
    ...(startupBackground === undefined ? {} : { startupBackground }),
    ...(startupImage ? { startupImage } : {}),
  });
  if (device.identity.modelName !== 'STU-540') {
    await device.close();
    throw new Error('This qualification script is for an STU-540.');
  }
  tablet = device;
  if (selected instanceof WebSerialTransport) {
    selectedSerialInfo = selected.port.getInfo();
    try {
      localStorage.setItem(serialSelectionKey, JSON.stringify(selectedSerialInfo));
    } catch {
      /* The active port remains usable if storage is unavailable. */
    }
  }
  device.on((event) => {
    if (device !== tablet) return;
    if (event.type === 'pen' && liveInk) draw(event.sample);
    if (event.type === 'disconnect') {
      const protocolFault =
        event.reason instanceof StuError && event.reason.code !== 'DISCONNECTED';
      const message = protocolFault
        ? `${failure(event.reason)}. Connection closed; use Reopen authorized tablet to retry.`
        : element<HTMLInputElement>('reconnect-auto').checked
          ? 'Tablet disconnected. Waiting for USB reconnection to reopen it automatically.'
          : 'Tablet disconnected. Reconnect, then use Reopen authorized tablet.';
      if (protocolFault && busy && currentResult) currentResult.technical = 'failed';
      controller?.abort(new Error(message));
      status.textContent = message;
      element('reconnect-status').textContent = message;
      setBusy(busy);
    }
    if (event.type === 'error') {
      inputFailure = event.error;
      status.textContent = failure(event.error);
      // Release manual drawing so an input failure becomes a failed check immediately.
      drawing.answer();
    }
  });
  evidence = {
    ...evidence,
    identity: device.identity,
    transport: handle.kind,
    ...(handle instanceof WebSerialTransport
      ? {
          baudRate: handle.baudRate,
          serialReportSizesIncludingId: Object.fromEntries(handle.reportSizes),
        }
      : { baudRate: undefined, serialReportSizesIncludingId: undefined }),
    capability: device.capability,
    imageFormats: device.display.formats,
    featureReports: Object.fromEntries(handle.limits.featureReports),
    inputReports: Object.fromEntries(handle.limits.inputReports),
    welcomeSource: startupImage?.source ?? 'none',
    startupBackground: startupBackground === undefined ? 'none' : colorHex(startupBackground),
    readyStabilityMs,
  };
  updateEvidence();
  await readAppearance();
  const image = welcome.connectionPreview();
  if (image) showExpected(image, 'Expected welcome image after this app connects.');
  else if (startupBackground !== undefined)
    showExpected(
      solidImage(device.capability.screenWidth, device.capability.screenHeight, startupBackground),
      'Expected remembered background after this app connects.',
    );
}
function connectionExpectation(): string {
  const background = backgroundPreference.startupColor;
  if (background === undefined) return welcome.connectionExpectation();
  if (welcome.connectionPreview())
    return `${welcome.connectionExpectation()} The clear-screen background setting should read ${colorHex(background)}; the welcome image stays visible.`;
  return `Once the tablet is ready, its entire display should become the remembered color ${colorHex(background)}, matching the preview.`;
}
async function closeTablet(): Promise<void> {
  const device = tablet;
  // close() emits disconnect too. Detach the active tablet before that event so
  // an intentional close cannot cancel the test that is reopening it.
  tablet = undefined;
  liveInk = false;
  previous = undefined;
  await device?.close();
}
button('connect', async () => {
  if (tablet?.state === 'open')
    throw new Error('Close the current connection before selecting another.');
  const selected = simulated ? authorizeSimulation() : await manager().requestDevice();
  if (!selected) return;
  await closeTablet();
  await step(
    'Connect to your STU-540',
    [
      'Check that the device details identify an STU-540 with an 800 × 480 display.',
      connectionExpectation(),
    ],
    async () => {
      await open(selected);
      element('reconnect-status').textContent = element<HTMLInputElement>('reconnect-auto').checked
        ? 'Connected. Automatic reopening is enabled for the next page load or USB connection.'
        : 'Connected. Automatic reopening is off.';
      return `${connected().identity.modelName}; ${connected().capability.screenWidth} × ${connected().capability.screenHeight}. Device details are below.`;
    },
  );
});
button('reopen', async () => {
  await step(
    'Reopen the authorized tablet',
    ['The connection should reopen without another device chooser.', connectionExpectation()],
    async () => {
      await closeTablet();
      signal();
      const devices = await authorizedTablets();
      if (devices.length !== 1)
        throw new Error(
          devices.length
            ? 'Several tablets are authorized; use Choose STU-540 to select one.'
            : 'No authorized tablet; use Choose STU-540.',
        );
      const selected = devices[0]!;
      await open(selected);
    },
  );
});
button('disconnect', async () => {
  await step(
    'Close the connection',
    [
      'The connection should close while the tablet stays powered on.',
      'The tablet image should remain unchanged.',
    ],
    async () => {
      await closeTablet();
      element('reconnect-status').textContent =
        'Connection closed by you. It stays closed until you reopen, reload the page or reconnect USB.';
      return 'Connection closed.';
    },
  );
});
button('welcome-show', async () => {
  const image = welcome.image;
  await step(
    'Preview welcome image',
    [
      'The tablet should show the prepared image, matching the preview in color, orientation and white margins.',
      'This sends the image to the display. It does not save a slot.',
    ],
    async () => {
      showExpected(image, 'Full-color welcome image sent to the display.');
      await connected().display.writeImage(image, {
        format: 'bgr24',
        timeoutMs: transferTimeout(),
        signal: signal(),
        onProgress: ({ sent, total }) => {
          progress.value = sent / total;
        },
      });
      return 'Welcome image sent to the display. Compare it with the preview.';
    },
  );
});
button('welcome-store', async () => {
  const device = connected(),
    slot = welcome.slot,
    image = welcome.image;
  const overwrite = element<HTMLInputElement>('welcome-overwrite').checked;
  const saved = await step(
    `Save welcome image · ${slot.kind} ${slot.number}`,
    [
      `Save the prepared image to ${slot.kind} slot ${slot.number}. A full image transfer happens once.`,
      'Wait for the saved slot and device hash below. The displayed image may remain unchanged during storage; the next step recalls it for visual comparison.',
      'Confirm the save completed for your chosen slot; this confirmation alone does not verify the stored pixels.',
    ],
    async () => {
      const reference = await device.rom.storeImage(slot, image, {
        overwrite,
        timeoutMs: transferTimeout(),
        signal: signal(),
        onProgress: ({ sent, total }) => {
          progress.value = sent / total;
        },
      });
      welcome.remember(reference, image);
      element<HTMLInputElement>('welcome-overwrite').checked = false;
      evidence.storedImage = { slot, hash: Array.from(reference.hash), readBack: true };
      updateEvidence();
      return `Saved ${slot.kind} ${slot.number}; the tablet returned its 16-byte image hash. Confirm to recall it and compare the pixels.`;
    },
  );
  if (saved) await recallWelcome();
});
async function recallWelcome(): Promise<void> {
  const { reference, image } = welcome.stored();
  await step(
    `Recall stored image · ${reference.slot.kind} ${reference.slot.number}`,
    [
      'The saved image should appear and match the preview in color, orientation and margins.',
      'The tablet hash is checked and a short display command is sent. No image pixels are transferred.',
      'Confirm the image itself; a successful command is not enough.',
    ],
    async () => {
      showExpected(image, 'Expected image saved in the selected tablet slot.');
      const started = performance.now();
      await connected().rom.display(reference.slot, {
        expectedHash: reference.hash,
        signal: signal(),
      });
      return `Stored image recalled in ${Math.round(performance.now() - started)} ms, including hash and status checks. No image data sent.`;
    },
  );
}
button('welcome-recall', recallWelcome);

function colorHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}
function showBackgroundColor(color: number): void {
  const hex = colorHex(color);
  element<HTMLInputElement>('background-color').value = hex;
  element<HTMLInputElement>('background-hex').value = hex;
  element('background-current').textContent = `Current tablet background: ${hex}.`;
}
function describeBackgroundPreference(): void {
  element<HTMLInputElement>('background-auto').checked = backgroundPreference.enabled;
  element('background-saved').textContent = !backgroundPreference.enabled
    ? 'Automatic background restore is off. The remembered color will not be applied on connect.'
    : backgroundPreference.color === undefined
      ? 'Apply a color to remember it and restore it after the tablet boots.'
      : `Remembered background: ${colorHex(backgroundPreference.color)}. Restored on each app connection, before the welcome image.`;
}
element('background-auto').addEventListener('change', () => {
  try {
    backgroundPreference.setEnabled(element<HTMLInputElement>('background-auto').checked);
    describeBackgroundPreference();
  } catch {
    element('background-saved').textContent =
      'Your background choice works for this page session, but browser storage could not be updated.';
  }
});
element('background-color').addEventListener('input', () => {
  element<HTMLInputElement>('background-hex').value =
    element<HTMLInputElement>('background-color').value.toUpperCase();
});
element('background-hex').addEventListener('input', () => {
  const hex = element<HTMLInputElement>('background-hex').value;
  if (/^#[0-9a-f]{6}$/i.test(hex)) element<HTMLInputElement>('background-color').value = hex;
});
async function readAppearance(): Promise<string[]> {
  const device = connected();
  const issues: string[] = [];
  try {
    const enabled = await device.settings.getBootScreen({ signal: signal() });
    element<HTMLInputElement>('boot-disabled').checked = !enabled;
    element('boot-current').textContent =
      `Current firmware boot screen: ${enabled ? 'enabled' : 'disabled'}.`;
    evidence.bootScreen = { enabled, readBack: true };
  } catch (error) {
    signal();
    const detail = `Boot-screen setting: ${failure(error)}`;
    element('boot-current').textContent = detail;
    evidence.bootScreen = { error: failure(error) };
    issues.push(detail);
  }
  try {
    const background = await device.settings.getBackground({ signal: signal() });
    showBackgroundColor(backgroundRgb(background));
    evidence.background = background;
  } catch (error) {
    signal();
    const detail = `Background setting: ${failure(error)}`;
    element('background-current').textContent = detail;
    evidence.background = { error: failure(error) };
    issues.push(detail);
  }
  updateEvidence();
  return issues;
}
button('appearance-read', async () => {
  await step(
    'Read boot screen and background settings',
    [
      'Check the current boot-screen flag and background color in Boot screen & background below.',
      'These are read-only queries. The tablet display should remain unchanged.',
    ],
    async () => {
      const issues = await readAppearance();
      if (issues.length) throw new Error(issues.join('; '));
      return 'Current display settings read from the tablet. No setting was changed.';
    },
  );
});
button('boot-apply', async () => {
  const enabled = !element<HTMLInputElement>('boot-disabled').checked;
  await step(
    `${enabled ? 'Enable' : 'Disable'} firmware boot screen`,
    [
      `The tablet should report its boot screen as ${enabled ? 'enabled' : 'disabled'} after the change.`,
      'The current image should remain unchanged. This operation does not restart the tablet.',
      'Confirm the setting readback and unchanged current display. A separate power cycle is needed to check the startup logo visually.',
    ],
    async () => {
      await applyBootScreen(connected(), enabled, { signal: signal() });
      element('boot-current').textContent =
        `Current firmware boot screen: ${enabled ? 'enabled' : 'disabled'} (read back after applying).`;
      evidence.bootScreen = { enabled, readBack: true, powerCycleVerified: false };
      updateEvidence();
      return `Boot screen ${enabled ? 'enabled' : 'disabled'} and readback matched. Power-on appearance has not been checked. Close the connection and complete its review before unplugging to check the next startup.`;
    },
  );
});
button('background-apply', async () => {
  const hex = element<HTMLInputElement>('background-hex').value;
  if (!/^#[0-9a-f]{6}$/i.test(hex))
    throw new Error('Enter a background color as #RRGGBB, for example #28664C.');
  const color = Number.parseInt(hex.slice(1), 16);
  await step(
    `Set tablet background · ${colorHex(color)}`,
    [
      'The entire tablet display should become the solid color shown in the preview.',
      'Check all four corners. The previous displayed image should be cleared with no remaining text or strokes.',
      'This sets the color used to clear the display. Stored images keep their original colors.',
    ],
    async () => {
      const device = connected();
      showExpected(
        solidImage(device.capability.screenWidth, device.capability.screenHeight, color),
        'Expected solid tablet background after clearing.',
      );
      const actual = await applyBackground(device, color, { signal: signal() });
      try {
        backgroundPreference.remember(color);
        describeBackgroundPreference();
      } catch {
        element('background-saved').textContent =
          'The applied color is remembered for this page session, but browser storage could not be updated.';
      }
      showExpected(
        solidImage(device.capability.screenWidth, device.capability.screenHeight, actual),
        'Expected solid tablet background after clearing.',
      );
      showBackgroundColor(actual);
      evidence.background = {
        requested: colorHex(color),
        displayed: colorHex(actual),
        readBack: true,
      };
      updateEvidence();
      return `Background ${colorHex(actual)} read back successfully and the display cleared. Compare the tablet with the preview.`;
    },
  );
});
button('baseline', async () => {
  const device = connected();
  await step(
    'Read device status and settings',
    [
      'Check that the model, firmware and 800 × 480 screen dimensions shown in Device details are plausible.',
      'This test reads settings. The tablet image should remain unchanged; confirm that it does.',
    ],
    async () => {
      const value = await device.getStatus({ signal: signal() });
      if (value.lastResult !== 0) throw new Error(`Device result ${value.lastResult}`);
      const probes = {
        inking: () => device.settings.getInking(),
        rendering: () => device.settings.getRenderingMode(),
        penReports: () => device.settings.getPenDataOptionMode(),
        thresholds: () => device.settings.getInkThreshold(),
        ink: () => device.settings.getInkStyle(),
        background: () => device.settings.getBackground(),
        handwritingArea: () => device.settings.getHandwritingArea(),
        backlight: () => device.settings.getBacklight(),
        reportRate: () => device.settings.getReportRate(),
        bootScreen: () => device.settings.getBootScreen(),
      };
      const settings: Record<string, unknown> = {};
      for (const [name, read] of Object.entries(probes)) {
        signal();
        try {
          settings[name] = await read();
        } catch (error) {
          if (!(error instanceof StuError && error.code === 'UNSUPPORTED_FEATURE')) throw error;
          settings[name] = 'Not supported by this device';
        }
      }
      evidence.settings = settings;
      updateEvidence();
      element<HTMLDetailsElement>('device-details').open = true;
      return 'Status and supported settings read successfully. Unsupported settings are labeled in Device details.';
    },
  );
});

async function restoreSettings(device: StuDevice, saved: Map<number, Uint8Array>): Promise<void> {
  if (device.state !== 'open') return;
  const errors: string[] = [];
  for (const [id, payload] of [...saved].reverse()) {
    try {
      await device.protocol.writeRaw(id, payload);
    } catch (error) {
      errors.push(`0x${id.toString(16)}: ${failure(error)}`);
    }
  }
  if (errors.length)
    throw new RestoreError(`Could not restore temporary settings: ${errors.join('; ')}`);
}
async function preserveSettings(ids: readonly number[], work: () => Promise<void>): Promise<void> {
  const device = connected();
  const saved = new Map<number, Uint8Array>();
  for (const id of ids) saved.set(id, await device.protocol.readRaw(id, { signal: signal() }));
  try {
    await work();
  } finally {
    await restoreSettings(device, saved);
  }
}
async function upload(
  image: RgbaImage,
  format: ImageFormat,
  area?: { x: number; y: number; width: number; height: number },
): Promise<void> {
  await connected().display.writeImage(image, {
    format,
    timeoutMs: transferTimeout(),
    ...(area ? { area } : {}),
    signal: signal(),
    onProgress: ({ sent, total }) => {
      progress.value = sent / total;
    },
  });
}
button('display', async () => {
  const device = connected();
  await preserveSettings([ReportId.InkingMode], async () => {
    await device.settings.setInking(false, { signal: signal() });
    for (const [i, format] of device.display.formats.entries()) {
      const mono = format === 'mono' || format === 'mono-zlib';
      const order = mono ? 'black, white, black, white, black' : 'red, green, blue, black, white';
      const image = pattern(device.capability.screenWidth, device.capability.screenHeight, format);
      await step(
        `Display ${i + 1} of ${device.display.formats.length} · ${format}`,
        [
          `Compare the tablet with the preview: five vertical bars, left to right ${order}.`,
          'Check the solid black border on all four edges, upright orientation and straight bar boundaries.',
          'Look for missing rows, shifted pixels or stray marks. Answer below; this image stays on the tablet until you do.',
        ],
        async () => {
          showExpected(
            image,
            `${format} · expected tablet image, ${image.width} × ${image.height}. Left to right: ${order}.`,
          );
          await upload(image, format);
          return 'Image sent successfully.';
        },
      );
    }
  });
});
button('partial', async () => {
  const device = connected();
  const base = whiteImage(device.capability.screenWidth, device.capability.screenHeight);
  await preserveSettings([ReportId.InkingMode], async () => {
    await device.settings.setInking(false, { signal: signal() });
    const ready = await step(
      'Partial update · 1 of 2 · white background',
      [
        'The entire tablet should now be white, matching the preview.',
        'Confirm that the previous image is completely gone before testing the small update.',
      ],
      async () => {
        showExpected(base, 'Expected tablet image before the partial update: completely white.');
        await upload(base, 'mono');
      },
    );
    if (!ready) return;
    const area = { x: 17, y: 23, width: 101, height: 53 };
    const patch = pattern(area.width, area.height, 'mono');
    await step(
      'Partial update · 2 of 2 · small rectangle',
      [
        'A small black-and-white striped rectangle should appear near the top-left, exactly as in the preview.',
        'It starts 17 pixels from the left and 23 from the top; it is 101 × 53 pixels, with a black border.',
        'Everything outside this rectangle must remain white. Check for diagonal shifts, wrapping or stray lines.',
      ],
      async () => {
        showExpected(
          overlay(base, patch, area.x, area.y),
          'Expected full screen after the update. Only the small 101 × 53 rectangle changes.',
        );
        await upload(patch, 'mono', area);
      },
    );
  });
});

function draw(sample: PenSample): void {
  if (!sample.inProximity || !sample.touching) {
    previous = undefined;
    return;
  }
  const device = connected();
  const paint = (target: CanvasRenderingContext2D): void => {
    const x = (sample.x * target.canvas.width) / device.capability.tabletMaxX;
    const y = (sample.y * target.canvas.height) / device.capability.tabletMaxY;
    target.strokeStyle = target.fillStyle = '#000';
    target.lineWidth = 2;
    target.lineCap = 'round';
    target.beginPath();
    if (previous) {
      target.moveTo(
        (previous.x * target.canvas.width) / device.capability.tabletMaxX,
        (previous.y * target.canvas.height) / device.capability.tabletMaxY,
      );
      target.lineTo(x, y);
      target.stroke();
    } else {
      target.arc(x, y, 1, 0, Math.PI * 2);
      target.fill();
    }
  };
  paint(penContext);
  if (drawOnTabletPreview) paint(context);
  previous = sample;
}
async function penSetup(work: () => Promise<void>): Promise<void> {
  const device = connected();
  const style =
    device.support(ReportId.HandwritingThicknessColor24).state === 'supported'
      ? ReportId.HandwritingThicknessColor24
      : ReportId.HandwritingThicknessColor;
  await preserveSettings(
    [ReportId.InkingMode, ReportId.RenderingMode, ReportId.HandwritingDisplayArea, style],
    async () => {
      await device.settings.setRenderingMode(0, { signal: signal() });
      await device.settings.setHandwritingArea(
        {
          x: 0,
          y: 0,
          width: device.capability.screenWidth,
          height: device.capability.screenHeight,
        },
        { signal: signal() },
      );
      await device.settings.setInkStyle({ color: 0, thickness: 2 }, { signal: signal() });
      await work();
    },
  );
}
async function captureStep(
  encryption: 'none' | 'required',
  ink: boolean,
  name: string,
): Promise<void> {
  const device = connected();
  const white = whiteImage(device.capability.screenWidth, device.capability.screenHeight);
  await step(
    name,
    [
      ink
        ? 'Draw a few separate strokes and marks near all four corners of the tablet. Black ink should appear on its white screen.'
        : 'Draw on the tablet. Its screen must stay completely white, while strokes appear in Recorded pen input below.',
      'Lift the pen between strokes. Check that the browser does not draw lines across those gaps or swap the corners.',
      'Take as long as you need, then click Finish drawing. Compare the result and give your verdict below.',
      ...(ink
        ? [
            'Compare stroke position, direction and shape. The browser reconstructs pen data; tiny stroke-width differences can occur.',
          ]
        : []),
    ],
    async () => {
      signature = undefined;
      inputFailure = undefined;
      await device.settings.setInking(false, { signal: signal() });
      showExpected(
        white,
        ink
          ? 'Expected tablet display: white background with your live strokes. Compare shape and position.'
          : 'Expected tablet display: stays white with inking disabled. The separate pen preview should still draw.',
      );
      await upload(white, 'mono');
      await device.settings.setInking(ink, { signal: signal() });
      if ((await device.settings.getInking({ signal: signal() })) !== ink)
        throw new Error('Inking setting readback disagrees with the requested value.');
      penCanvas.width = white.width;
      penCanvas.height = white.height;
      penContext.fillStyle = 'white';
      penContext.fillRect(0, 0, white.width, white.height);
      element('pen-panel').hidden = false;
      previous = undefined;
      drawOnTabletPreview = ink;
      recording = device.capture.create({ encryption, maxSamples: 100_000 });
      try {
        await recording.start({ signal: signal() });
        liveInk = true;
        element('step-phase').textContent = 'Draw on the tablet';
        element('step-details').textContent =
          'Capture is active. Click Finish drawing when you are ready to compare.';
        status.textContent = 'Draw now. There is no five-second countdown.';
        const finished = drawing.wait(signal());
        element('finish-drawing').hidden = false;
        if (simulated && handle instanceof MockTransport) {
          for (let i = 0; i < 100; i++) {
            const sample = penFixture({
              x: 1000 + i * 60,
              y: Math.round(2400 + Math.sin(i / 7) * 1100),
              pressure: 700,
            });
            handle.emit(sample.reportId, sample.payload, i * 5);
          }
        }
        await finished;
        if (inputFailure) throw inputFailure;
        signature = await recording.finish({ signal: signal() });
        liveInk = false;
        // Freeze the tablet too, so marks added during review cannot diverge from the preview.
        await device.settings.setInking(false, { signal: signal() });
        if (!signature.complete || !signature.hasInk)
          throw new Error('No complete drawing received. Draw with pen contact, then retry.');
        if (encryption === 'required' && signature.metadata.protection.kind !== 'rsa-aes')
          throw new Error('RSA/AES protection was not established.');
        return `${signature.samples.length} samples, ${signature.strokes.length} strokes, ${signature.loss.length} loss indicators; ${signature.metadata.protection.kind}. Compare the tablet and previews before confirming.`;
      } finally {
        liveInk = false;
        previous = undefined;
        try {
          await recording.dispose();
        } finally {
          recording = undefined;
        }
      }
    },
  );
}
button('capture', () =>
  penSetup(() => captureStep('none', true, 'Plaintext capture · draw and compare')),
);
button('encrypted', () =>
  penSetup(() => captureStep('required', true, 'Encrypted capture · draw and compare')),
);
button('settings', () =>
  penSetup(async () => {
    await captureStep('none', false, 'Inking · 1 of 2 · tablet ink off');
    await captureStep('none', true, 'Inking · 2 of 2 · tablet ink on');
  }),
);
button('rom', async () => {
  const device = connected();
  await step(
    'ROM inspection · current mode and image area',
    [
      'This check reads the current mode and image area. The tablet image should stay unchanged.',
      'Check that the tablet does not restart or start a slideshow. No ROM image should be uploaded or deleted.',
    ],
    async () => {
      evidence.operationMode = await device.modes.get({ signal: signal() });
      evidence.currentImageArea = await device.rom.getCurrentArea({ signal: signal() });
      updateEvidence();
      return 'Current mode and image area read successfully. Confirm that the tablet image did not change.';
    },
  );
  const slots: Record<string, unknown> = {};
  evidence.romInspection = slots;
  for (const kind of ['signature', 'keypad', 'pinpad', 'slideshow', 'message'] as const) {
    await step(
      `ROM inspection · ${kind} slot 1`,
      [
        `This check requests hash metadata for ${kind} slot 1. It does not upload, delete or display a stored image.`,
        'Confirm that the tablet keeps its current image, stays responsive and does not restart.',
      ],
      async () => {
        try {
          const hash = await device.rom.getHash({ kind, number: 1 }, { signal: signal() });
          slots[kind] = { result: hash.result, hashBytes: hash.hash.length };
          return `Slot metadata read: result ${hash.result}, ${hash.hash.length} hash bytes. The slot result is recorded separately from your visual confirmation.`;
        } catch (error) {
          slots[kind] = { error: failure(error) };
          throw error;
        } finally {
          updateEvidence();
        }
      },
    );
  }
});
button('cycles', async () => {
  if (!handle) throw new Error('Select a tablet first.');
  for (let i = 1; i <= 10; i++) {
    await step(
      `Reconnect · ${i} of 10`,
      [
        'The connection closes and opens once. The tablet should stay powered on.',
        connectionExpectation(),
        'Confirm there is no unexpected restart, blanking or error before the next cycle.',
      ],
      async () => {
        await closeTablet();
        signal();
        await open(handle!);
      },
    );
  }
});
button('software', async () => {
  await step(
    'Software-only drawing check',
    [
      'This step uses a simulated tablet. Your physical tablet is not changed.',
      'The preview should contain one smooth wavy stroke. This confirmation is labeled software evidence in the report.',
    ],
    async () => {
      const mock = new MockTransport({ width: 800, height: 480 });
      const virtual = await StuDevice.open(mock);
      const capture = virtual.capture.create({ encryption: 'none' });
      try {
        await capture.start();
        for (let i = 0; i < 100; i++) {
          const sample = penFixture({
            x: 1000 + i * 60,
            y: Math.round(2400 + Math.sin(i / 7) * 1100),
            pressure: 700,
            sequence: (65500 + i) % 65536,
            time: i * 5,
          });
          mock.emit(sample.reportId, sample.payload, i * 5);
        }
        const synthetic = await capture.finish();
        if (!synthetic.complete || synthetic.samples.length !== 100)
          throw new Error('Synthetic recording was not preserved');
        showExpected(
          whiteImage(800, 480),
          'Software-only preview. No image was sent to your tablet.',
        );
        drawSignature(context, synthetic, { background: '#fff' });
        const png = new Uint8Array(await (await toPNGBlob(synthetic)).arrayBuffer());
        if (![137, 80, 78, 71, 13, 10, 26, 10].every((value, i) => png[i] === value))
          throw new Error('PNG export failed');
        if (!(await toSVGBlob(synthetic).text()).includes('<path'))
          throw new Error('SVG export failed');
        return 'Synthetic capture, sequence rollover, canvas, PNG and SVG checks completed. No physical-device evidence.';
      } finally {
        await capture.dispose();
        await virtual.close();
      }
    },
    'software',
  );
});
function download(blob: Blob, filename: string): void {
  const object = createObjectURL(blob);
  const link = document.createElement('a');
  link.href = object.url;
  link.download = filename;
  link.click();
  setTimeout(() => object.dispose(), 1000);
}
element('svg').addEventListener('click', () => {
  if (!signature) {
    status.textContent = 'Finish a drawing first.';
    return;
  }
  download(new Blob([signature.toSVG()], { type: 'image/svg+xml' }), 'stusign-test-capture.svg');
});
element('export').addEventListener('click', () => {
  download(
    new Blob(
      [
        JSON.stringify(
          {
            format: 'stusign.hardware-report',
            version: 2,
            mode: simulated ? 'simulation' : 'hardware',
            testedAt: new Date().toISOString(),
            environment: navigator.userAgent,
            device: evidence,
            results,
            observations: element<HTMLTextAreaElement>('notes').value,
          },
          null,
          2,
        ),
      ],
      { type: 'application/json' },
    ),
    `stusign-stu540-${new Date().toISOString().slice(0, 10)}.json`,
  );
});
if (simulated) {
  element('simulation').hidden = false;
  element('connect').textContent = 'Connect simulated STU-540';
  element<HTMLButtonElement>('encrypted').disabled = true;
}
function transferTimeout(): number {
  return handle?.kind === 'webserial' ? 300_000 : 120_000;
}
function hid(): ReturnType<typeof createWebHidManager> {
  return (hidManager ??= createWebHidManager());
}
function serial(): ReturnType<typeof createWebSerialManager> {
  return (serialManager ??= createWebSerialManager({
    baudRate: connectionMode === 'serial-rs232' ? 115200 : 128000,
  }));
}
function manager():
  ReturnType<typeof createWebHidManager> | ReturnType<typeof createWebSerialManager> {
  return connectionMode === 'hid' ? hid() : serial();
}
function describeConnection(): void {
  element<HTMLSelectElement>('connection-mode').value = connectionMode;
  element('connection-help').textContent = simulated
    ? 'Simulation uses a mock tablet; it does not test USB or serial hardware.'
    : connectionMode === 'hid'
      ? 'Choose the LCD Signature Pad in the HID chooser. Close the connection to change transport.'
      : 'Choose the tablet’s serial port (it may be named USB Serial or FTDI). The tablet must already be in COM mode. Color uploads can take a few minutes; stored-image recall is fast. Changing this selector does not change the tablet’s saved mode.';
}
function observeConnections(): void {
  unsubscribeConnections?.();
  unsubscribeConnections = undefined;
  if (simulated) return;
  if (connectionMode === 'hid') {
    unsubscribeConnections = hid().onConnection((event) => {
      if (event.device.productId !== 0x00a8) return;
      if (event.connected) void reconnect?.request('USB connection');
      else if (handle instanceof WebHidTransport && handle.device === event.device) {
        reconnect?.cancelPending();
        controller?.abort(new Error('Tablet disconnected. Waiting for USB reconnection.'));
      }
    });
  } else {
    unsubscribeConnections = serial().onConnection((event) => {
      if (event.connected) void reconnect?.request('USB connection');
      else if (handle instanceof WebSerialTransport && handle.port === event.port) {
        reconnect?.cancelPending();
        controller?.abort(new Error('Serial tablet disconnected. Waiting for USB reconnection.'));
      }
    });
  }
}
function simulationTablet(): MockTransport {
  return (virtualTablet ??= new MockTransport({
    width: 800,
    height: 480,
    blockCapacity: 2557,
    simulateRom: true,
    beforeRead: async (id) => {
      if (simulatedBootAt === undefined) return;
      const elapsed = performance.now() - simulatedBootAt;
      if (elapsed < 300) throw new StuError('TRANSPORT', 'Simulated firmware is starting');
      // Include an early Ready response before the boot image takes over the display.
      const state = elapsed < 600 ? 0xff : elapsed < 900 ? 0 : elapsed < 3000 ? 4 : 0;
      if (id === ReportId.Status) virtualTablet!.reports.set(id, Uint8Array.of(state, 0, 0, 0));
      if (elapsed >= 3000) simulatedBootAt = undefined;
    },
  }));
}
function authorizeSimulation(): MockTransport {
  if (!simulatedAttached) throw new Error('Use Simulate USB reconnect first.');
  simulatedAuthorized = true;
  try {
    localStorage.setItem(simulatedPermissionKey, 'true');
  } catch {
    /* Session-only simulation. */
  }
  return simulationTablet();
}
async function authorizedTablets(): Promise<readonly ReportTransport[]> {
  if (simulated) return simulatedAttached && simulatedAuthorized ? [simulationTablet()] : [];
  if (connectionMode !== 'hid') {
    // Do not probe unrelated grants when someone first switches from HID to serial.
    // Browsers expose adapter IDs, not a unique tablet identity. Multiple matches
    // still require the chooser, and open() verifies the STU model before settings.
    if (!selectedSerialInfo) return [];
    return (await serial().getAuthorizedDevices()).filter(({ port }) => {
      const info = port.getInfo();
      return (
        info.usbVendorId === selectedSerialInfo!.usbVendorId &&
        info.usbProductId === selectedSerialInfo!.usbProductId
      );
    });
  }
  // Wacom's ProductId_540 is 0x00a8. This harness must not open another STU model automatically.
  return (await hid().getAuthorizedDevices()).filter(
    (device) => device.device.productId === 0x00a8,
  );
}
async function automaticReopen(selected: ReportTransport, reason: ReconnectReason): Promise<void> {
  await runOperation('Automatic tablet reconnection', async () => {
    await step(
      'Automatically reopen the authorized tablet',
      [
        `The previously authorized STU-540 should reconnect after ${reason}, without a device chooser.`,
        connectionExpectation(),
        'Confirm the connection and expected display before starting another test.',
      ],
      async () => {
        await closeTablet();
        signal();
        await open(selected, reason);
        evidence.reconnection = { automatic: true, reason };
        updateEvidence();
        element('reconnect-status').textContent =
          'Authorized STU-540 reopened automatically. Review the connection check.';
        return `Authorized STU-540 reopened after ${reason}. Checked readiness, then applied the remembered background and welcome-image options.`;
      },
    );
  });
}
reconnect = new AutoReconnect({
  getAuthorizedDevices: authorizedTablets,
  isBusy: () => busy || welcome.loading || !reconnectReady,
  isConnected: () => tablet?.state === 'open',
  open: automaticReopen,
  notice: (message) => {
    element('reconnect-status').textContent = message;
  },
  error: (error) => {
    element('reconnect-status').textContent =
      `Automatic reopening failed: ${failure(error)}. Use Choose STU-540 or Reopen authorized tablet to retry.`;
  },
});
element('reconnect-auto').addEventListener('change', () => {
  const enabled = element<HTMLInputElement>('reconnect-auto').checked;
  try {
    localStorage.setItem(reconnectKey, String(enabled));
    element('reconnect-status').textContent = enabled
      ? 'Automatic reopening is enabled for page load and USB connection.'
      : 'Automatic reopening is off. Your choice is remembered.';
  } catch {
    element('reconnect-status').textContent =
      'This choice works for this page session, but browser storage could not be updated.';
  }
  void reconnect!.setEnabled(enabled);
});
element('connection-mode').addEventListener('change', () => {
  reconnect?.cancelPending();
  const mode = element<HTMLSelectElement>('connection-mode').value;
  connectionMode = mode === 'serial-usb' || mode === 'serial-rs232' ? mode : 'hid';
  serialManager = undefined;
  describeConnection();
  try {
    localStorage.setItem(connectionKey, connectionMode);
  } catch {
    /* Session-only preference. */
  }
  try {
    observeConnections();
    void reconnect?.request('option enabled');
  } catch (error) {
    element('reconnect-status').textContent = failure(error);
  }
});
element('simulate-unplug').addEventListener('click', () => {
  if (!simulated || !simulatedAttached) return;
  simulatedAttached = false;
  reconnect?.cancelPending();
  virtualTablet?.disconnect();
  controller?.abort(new Error('Simulated tablet disconnected. Waiting for USB reconnection.'));
  // A power cycle resets this volatile setting, but preserves simulated ROM slots.
  virtualTablet?.reports.set(ReportId.BackgroundColor24, Uint8Array.of(255, 255, 255));
  virtualTablet?.reports.set(ReportId.Status, new Uint8Array(4));
  element<HTMLButtonElement>('simulate-unplug').disabled = true;
  element<HTMLButtonElement>('simulate-replug').disabled = false;
});
element('simulate-replug').addEventListener('click', () => {
  if (!simulated || simulatedAttached) return;
  simulatedAttached = true;
  simulatedBootAt = performance.now();
  element<HTMLButtonElement>('simulate-unplug').disabled = false;
  element<HTMLButtonElement>('simulate-replug').disabled = true;
  void reconnect?.request('USB connection');
});
try {
  const saved = localStorage.getItem(connectionKey);
  if (!simulated && (saved === 'serial-usb' || saved === 'serial-rs232')) connectionMode = saved;
  const raw: unknown = JSON.parse(localStorage.getItem(serialSelectionKey) ?? 'null');
  if (raw && typeof raw === 'object') {
    const info = raw as SerialPortInfo;
    const validId = (value: unknown): boolean =>
      value === undefined ||
      (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 65535);
    if (validId(info.usbVendorId) && validId(info.usbProductId)) selectedSerialInfo = info;
  }
} catch {
  /* Use HID and explicit selection if the preference cannot be restored. */
}
describeConnection();
setBusy(false);
void welcome.restore().then(async () => {
  if (pageClosed) return;
  try {
    backgroundPreference.restore();
    describeBackgroundPreference();
    if (backgroundPreference.color !== undefined) {
      const hex = colorHex(backgroundPreference.color);
      element<HTMLInputElement>('background-color').value = hex;
      element<HTMLInputElement>('background-hex').value = hex;
    }
  } catch (error) {
    element('background-saved').textContent =
      `Could not restore the background preference: ${failure(error)}`;
  }
  element<HTMLInputElement>('reconnect-auto').checked = false;
  try {
    simulatedAuthorized = simulated && localStorage.getItem(simulatedPermissionKey) === 'true';
    element<HTMLInputElement>('reconnect-auto').checked =
      localStorage.getItem(reconnectKey) === 'true';
  } catch {
    element('reconnect-status').textContent =
      'Could not read the saved reconnection preference. Automatic reopening is off.';
  }
  if (!simulated) {
    try {
      observeConnections();
    } catch (error) {
      element('reconnect-status').textContent = failure(error);
    }
  }
  reconnectReady = true;
  await reconnect!.setEnabled(element<HTMLInputElement>('reconnect-auto').checked, 'page load');
});
window.addEventListener('pagehide', () => {
  pageClosed = true;
  unsubscribeConnections?.();
  reconnect?.dispose();
  controller?.abort(new DOMException('Page closed.', 'AbortError'));
  void closeTablet();
});
